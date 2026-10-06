import { test } from "node:test";
import assert from "node:assert/strict";
import { decideStop } from "../src/gate.ts";
import type { StopInput } from "../src/gate.ts";
import { loadOrCreateSigner, publicKeyEntry, signRecord } from "../src/sign.ts";
import { defaultState } from "../src/state.ts";
import type { CheckOutcome, Coverage } from "../src/types.ts";
import { lock, proposal, tempDir } from "./helpers.ts";

const signer = loadOrCreateSigner(tempDir());
const keyring = new Map([[signer.id, publicKeyEntry(signer.publicPem, { name: "sam", file: ".thisisfine/keys/sam.pub", local: true })]]);
const l1 = signRecord(lock({ words: "y, perfect", confirmedAt: "2026-10-03T12:00:00.000Z" }), signer);
const l2 = signRecord(lock({ proposal: "p2", number: 2, sentence: "Logo links home", check: ".thisisfine/checks/2-logo.spec.ts" }), signer);

const C1 = ".thisisfine/checks/1-badge.spec.ts";
const C2 = ".thisisfine/checks/2-logo.spec.ts";
const NOW = Date.parse("2026-10-06T12:00:00.000Z");

/** A map made at tree-0 in which only #2 loads public/logo.svg. */
const map = (over: Partial<Coverage> = {}): Coverage => ({
  tree: "tree-0", madeAt: "2026-10-06T11:00:00.000Z", checks: [C1, C2],
  files: { "public/index.html": [C1, C2], "public/logo.svg": [C2] }, dynamic: [], selectedRuns: 0, ...over
});

function input(over: Partial<StopInput> = {}, results: Record<string, CheckOutcome["status"]> = {}): StopInput & { ran: string[][]; recorded: boolean[] } {
  const ran: string[][] = [];
  const recorded: boolean[] = [];
  return {
    ran, recorded,
    records: [proposal(), l1, proposal({ id: "p2", number: 2 }), l2],
    readError: null,
    mirror: [l1, l2],
    keyring,
    hashOf: () => "abcdabcdabcdabcd",
    treeId: "tree-A",
    state: defaultState(),
    changedSince: () => ["public/logo.svg"],
    now: NOW,
    runAll: async (checks, record) => {
      ran.push(checks);
      recorded.push(record);
      const outcomes = checks.map((check): CheckOutcome => {
        const status = results[check] ?? "passed";
        return { check, status, message: status === "failed" ? "Expected: \"3\"\nReceived: \"0\"" : "", screenshot: status === "failed" ? ".thisisfine/runs/r/shot.png" : null };
      });
      return { outcomes, coverage: record ? map({ tree: "recorded", madeAt: "new" }) : null };
    },
    ...over
  };
}

test("no promises: allow without running anything", async () => {
  const i = input({ records: [], mirror: [] });
  const d = await decideStop(i);
  assert.equal(d.block, false);
  assert.deepEqual(i.ran, []);
});

test("all pass: allow, say so, remember the green tree", async () => {
  const i = input();
  const d = await decideStop(i);
  assert.equal(d.block, false);
  assert.equal(d.systemMessage, "☕ This is fine. 2/2 promises kept.");
  assert.equal(d.state.lastGreenTree, "tree-A");
  assert.deepEqual(i.ran, [[".thisisfine/checks/1-badge.spec.ts", ".thisisfine/checks/2-logo.spec.ts"]]);
});

test("same tree as the last green run: allow without running", async () => {
  const i = input({ state: { ...defaultState(), lastGreenTree: "tree-A" } });
  const d = await decideStop(i);
  assert.equal(d.block, false);
  assert.deepEqual(i.ran, []);
});

test("a broken promise blocks with the human's words and the evidence", async () => {
  const d = await decideStop(input({}, { ".thisisfine/checks/1-badge.spec.ts": "failed" }));
  assert.equal(d.block, true);
  assert.match(d.reason, /You broke promise #1 "Badge shows the cart count"/);
  assert.match(d.reason, /Oct 3: "y, perfect"/);
  assert.match(d.reason, /Received: "0"/);
  assert.match(d.reason, /shot\.png/);
  assert.match(d.systemMessage, /This is NOT fine/);
  assert.equal(d.state.lastGreenTree, null);
});

test("a missing result blocks too", async () => {
  const d = await decideStop(input({}, { ".thisisfine/checks/2-logo.spec.ts": "missing" }));
  assert.equal(d.block, true);
  assert.match(d.reason, /#2/);
});

test("flaky warns but does not block", async () => {
  const d = await decideStop(input({}, { ".thisisfine/checks/2-logo.spec.ts": "flaky" }));
  assert.equal(d.block, false);
  assert.match(d.systemMessage, /#2 was flaky/);
});

test("integrity problems block before anything runs", async () => {
  const i = input({ hashOf: (c) => (c.includes("1-badge") ? "ffffffffffffffff" : "abcdabcdabcdabcd") });
  const d = await decideStop(i);
  assert.equal(d.block, true);
  assert.match(d.reason, /#1's check was changed after you confirmed it/);
  assert.match(d.reason, /thisisfine restore/);
  assert.deepEqual(i.ran, []);
});

test("an unreadable ledger blocks", async () => {
  const d = await decideStop(input({ readError: "line 3: not valid JSON" }));
  assert.equal(d.block, true);
  assert.match(d.reason, /line 3/);
});

test("the app not starting blocks", async () => {
  const d = await decideStop(input({ runAll: async () => { throw new Error("\"npm start\" exited with code 1"); } }));
  assert.equal(d.block, true);
  assert.match(d.reason, /exited with code 1/);
});

test("a browser that can't start is uncheckable, not a broken promise", async () => {
  const launch = "Error: browserType.launch: spawn EPERM\nCall log:\n  - <launching> chrome-headless-shell.exe --headless";
  const runAll: StopInput["runAll"] = async (checks) => ({ outcomes: checks.map((check) => ({ check, status: "failed" as const, message: launch, screenshot: null })), coverage: null });
  const d = await decideStop(input({ runAll }));
  assert.equal(d.block, true, "nothing was checked, so it can't pass");
  assert.doesNotMatch(d.reason, /You broke/);
  assert.match(d.reason, /couldn't start the browser/);
  assert.match(d.reason, /spawn EPERM/);
  assert.doesNotMatch(d.reason, /Get the app starting/, "the app is fine; the machine isn't");
  assert.match(d.systemMessage, /browser/);
});

test("after 3 identical blocks the 4th stop is allowed and the human is told", async () => {
  let state = defaultState();
  for (let n = 1; n <= 3; n++) {
    const d = await decideStop(input({ state }, { ".thisisfine/checks/1-badge.spec.ts": "failed" }));
    assert.equal(d.block, true, `block ${n}`);
    state = d.state;
  }
  const d = await decideStop(input({ state }, { ".thisisfine/checks/1-badge.spec.ts": "failed" }));
  assert.equal(d.block, false);
  assert.match(d.systemMessage, /couldn't keep promise #1 after 3 tries/);
  assert.equal(d.state.consecutiveBlocks, 0);
});

test("a different failure resets the loop counter", async () => {
  let state = defaultState();
  for (let n = 0; n < 3; n++) state = (await decideStop(input({ state }, { ".thisisfine/checks/1-badge.spec.ts": "failed" }))).state;
  const d = await decideStop(input({ state }, { ".thisisfine/checks/2-logo.spec.ts": "failed" }));
  assert.equal(d.block, true);
  assert.equal(d.state.consecutiveBlocks, 1);
});

test("pending proposals are put to the human on stop", async () => {
  const i = input({ records: [proposal(), l1, proposal({ id: "p2", number: 2, sentence: "Logo links home" })], mirror: [l1] });
  const d = await decideStop(i);
  assert.equal(d.block, false);
  assert.match(d.systemMessage, /Lock in promise #2 "Logo links home"\?/);
  assert.match(d.systemMessage, /Reply y/);
});

// ── running only what a change can affect ────────────────────────────────

test("a full green run records the map and stores it against this tree", async () => {
  const i = input();
  const d = await decideStop(i);
  assert.deepEqual(i.recorded, [true]);
  assert.deepEqual(d.state.coverage, map({ tree: "recorded", madeAt: "new" }));
  assert.equal(d.state.lastGreenTree, "tree-A");
  assert.equal(d.state.lastSelectedTree, null);
});

test("with a map, a change only #2 loaded runs only #2, unrecorded", async () => {
  const i = input({ state: { ...defaultState(), lastGreenTree: "tree-0", coverage: map() } });
  const d = await decideStop(i);
  assert.equal(d.block, false);
  assert.deepEqual(i.ran, [[C2]]);
  assert.deepEqual(i.recorded, [false]);
  assert.equal(d.systemMessage, "☕ This is fine. 1/1 promise this change can affect kept (1 others skipped: only public/logo.svg changed).");
});

test("a passing partial run never stands in for a full one", async () => {
  const i = input({ state: { ...defaultState(), lastGreenTree: "tree-0", coverage: map() } });
  const d = await decideStop(i);
  assert.equal(d.state.lastGreenTree, "tree-0", "the last *full* green tree stays where it was");
  assert.equal(d.state.lastSelectedTree, "tree-A");
  assert.equal(d.state.coverage?.tree, "tree-0", "later diffs still start from the full run");
  assert.equal(d.state.coverage?.selectedRuns, 1);
});

test("stopping again on a tree a partial run passed skips, unless a full run is due", async () => {
  const state = { ...defaultState(), lastGreenTree: "tree-0", lastSelectedTree: "tree-A", coverage: map({ selectedRuns: 1 }) };
  const skip = input({ state });
  await decideStop(skip);
  assert.deepEqual(skip.ran, []);

  const due = input({ state: { ...state, coverage: map({ selectedRuns: 5 }) } });
  const d = await decideStop(due);
  assert.deepEqual(due.ran, [[C1, C2]]);
  assert.deepEqual(due.recorded, [true]);
  assert.equal(d.state.lastGreenTree, "tree-A");
  assert.equal(d.state.coverage?.tree, "recorded");
});

test("a change to anything unmapped runs everything", async () => {
  const i = input({ state: { ...defaultState(), coverage: map() }, changedSince: () => ["server.mjs"] });
  await decideStop(i);
  assert.deepEqual(i.ran, [[C1, C2]]);
});

test("forceAll runs everything even when a partial run would do", async () => {
  const i = input({ state: { ...defaultState(), coverage: map() }, forceAll: true });
  await decideStop(i);
  assert.deepEqual(i.ran, [[C1, C2]]);
});

test("a failing partial run blocks and keeps the map", async () => {
  const i = input({ state: { ...defaultState(), lastGreenTree: "tree-0", lastSelectedTree: "tree-B", coverage: map() } }, { [C2]: "failed" });
  const d = await decideStop(i);
  assert.equal(d.block, true);
  assert.match(d.reason, /#2/);
  assert.equal(d.state.lastSelectedTree, null);
  assert.equal(d.state.lastGreenTree, null);
  assert.deepEqual(d.state.coverage, map());
});

test("a failing full run doesn't replace the map: a failed check may have stopped before loading everything", async () => {
  const i = input({ state: { ...defaultState(), coverage: map({ selectedRuns: 5 }) } }, { [C1]: "failed" });
  const d = await decideStop(i);
  assert.equal(d.block, true);
  assert.deepEqual(d.state.coverage, map({ selectedRuns: 5 }));
});

test("a full run that couldn't record leaves no map", async () => {
  const i = input({ runAll: async (checks) => ({ outcomes: checks.map((check) => ({ check, status: "passed" as const, message: "", screenshot: null })), coverage: null }) });
  const d = await decideStop({ ...i, state: { ...defaultState(), coverage: map({ selectedRuns: 5 }) } });
  assert.equal(d.state.coverage, null);
});
