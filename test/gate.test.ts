import { test } from "node:test";
import assert from "node:assert/strict";
import { decideStop } from "../src/gate.ts";
import type { StopInput } from "../src/gate.ts";
import { loadOrCreateSigner, publicKeyEntry, signRecord } from "../src/sign.ts";
import { defaultState } from "../src/state.ts";
import type { CheckOutcome } from "../src/types.ts";
import { lock, proposal, tempDir } from "./helpers.ts";

const signer = loadOrCreateSigner(tempDir());
const keyring = new Map([[signer.id, publicKeyEntry(signer.publicPem, { name: "sam", file: ".thisisfine/keys/sam.pub", local: true })]]);
const l1 = signRecord(lock({ words: "y, perfect", confirmedAt: "2026-10-03T12:00:00.000Z" }), signer);
const l2 = signRecord(lock({ proposal: "p2", number: 2, sentence: "Logo links home", check: ".thisisfine/checks/2-logo.spec.ts" }), signer);

function input(over: Partial<StopInput> = {}, results: Record<string, CheckOutcome["status"]> = {}): StopInput & { ran: string[][] } {
  const ran: string[][] = [];
  return {
    ran,
    records: [proposal(), l1, proposal({ id: "p2", number: 2 }), l2],
    readError: null,
    mirror: [l1, l2],
    keyring,
    hashOf: () => "abcdabcdabcdabcd",
    treeId: "tree-A",
    state: defaultState(),
    runAll: async (checks) => {
      ran.push(checks);
      return checks.map((check) => {
        const status = results[check] ?? "passed";
        return { check, status, message: status === "failed" ? "Expected: \"3\"\nReceived: \"0\"" : "", screenshot: status === "failed" ? ".thisisfine/runs/r/shot.png" : null };
      });
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
