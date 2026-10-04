import { test } from "node:test";
import assert from "node:assert/strict";
import { prove } from "../src/prove.ts";
import type { ProveDeps } from "../src/prove.ts";
import { DEFAULTS } from "../src/config.ts";
import type { CheckOutcome } from "../src/types.ts";

const ROOT = "/proj";
const CHECK = ".thisisfine/checks/1-badge.spec.ts";
const config = { start: "node server.js", ...DEFAULTS };

/**
 * Fakes keyed by where the app was started: the real tree is ROOT, the
 * proof worktree is anything else. `nowStatus` / `withoutStatus` say how the
 * check behaves in each; `withoutBoots: false` makes the worktree app crash.
 */
function deps(o: { nowStatus?: CheckOutcome["status"]; withoutStatus?: CheckOutcome["status"]; withoutBoots?: boolean; base?: string | null }) {
  const calls: string[] = [];
  const d: ProveDeps = {
    startApp: async (s) => {
      const where = s.cwd === ROOT ? "now" : "without";
      calls.push(`start:${where}`);
      if (where === "without" && o.withoutBoots === false) throw new Error("exited with code 1");
      return { url: `http://${where}`, port: 1, stop: async () => void calls.push(`stop:${where}`) };
    },
    runChecks: async (r) => {
      const where = r.baseUrl === "http://now" ? "now" : "without";
      calls.push(`run:${where}:retries=${r.retries}`);
      const status = where === "now" ? (o.nowStatus ?? "passed") : (o.withoutStatus ?? "failed");
      return [{ check: CHECK, status, message: status === "failed" ? "expected 3, got 0" : "", screenshot: `${where}.png` }];
    },
    snapshotCommit: () => (calls.push("snapshot"), "snap"),
    defaultBase: () => (o.base === undefined ? "HEAD~1" : o.base),
    resolveRef: (_r, ref) => (ref === "nope" ? null : `sha-of-${ref}`),
    addWorktree: (_r, sha) => void calls.push(`worktree:${sha}`),
    prepareWorktree: () => void calls.push("prepare"),
    applyPatch: (_d, p) => void calls.push(`patch:${p}`),
    removeWorktree: () => void calls.push("remove"),
    tempDir: () => "/tmp/wt"
  };
  return { d, calls };
}

const run = (o: Parameters<typeof deps>[0], extra: { base?: string; sabotage?: { patch: string; note: string } } = {}) => {
  const { d, calls } = deps(o);
  return { calls, result: prove({ root: ROOT, config, check: CHECK, runDir: "/runs/x", deps: d, ...extra }) };
};

test("passes now + fails on HEAD~1 while booting = proven", async () => {
  const { result, calls } = run({});
  const proof = await result;
  assert.equal(proof.proven, true);
  assert.equal(proof.without.method, "base");
  assert.equal(proof.without.ref, "HEAD~1");
  assert.equal(proof.without.message, "expected 3, got 0");
  assert.equal(proof.now.screenshot, "now.png");
  assert.ok(calls.includes("run:now:retries=0"), "now must pass first time");
  assert.ok(calls.includes("run:without:retries=1"), "without must fail twice");
  assert.ok(calls.includes("worktree:sha-of-HEAD~1"));
  assert.ok(calls.includes("stop:without") && calls.includes("remove"), "cleans up");
});

test("a check that fails now is refused outright", async () => {
  await assert.rejects(run({ nowStatus: "failed" }).result, /fails on the current app/);
});

test("passing on the base too = unproven, with a hint", async () => {
  const proof = await run({ withoutStatus: "passed" }).result;
  assert.equal(proof.proven, false);
  assert.match(proof.reason, /also passes on HEAD~1/);
  assert.match(proof.reason, /--sabotage/);
});

test("a base that doesn't boot proves nothing", async () => {
  const { result, calls } = run({ withoutBoots: false });
  const proof = await result;
  assert.equal(proof.proven, false);
  assert.equal(proof.without.booted, false);
  assert.match(proof.reason, /doesn't start/);
  assert.ok(calls.includes("remove"));
});

test("sabotage snapshots the working tree and applies the patch", async () => {
  const { result, calls } = run({}, { sabotage: { patch: "/p.patch", note: "badge hidden" } });
  const proof = await result;
  assert.equal(proof.proven, true);
  assert.equal(proof.without.method, "sabotage");
  assert.equal(proof.without.note, "badge hidden");
  assert.deepEqual(calls.filter((c) => /snapshot|worktree|patch/.test(c)), ["snapshot", "worktree:snap", "patch:/p.patch"]);
});

test("no earlier version and no sabotage = unproven, method none", async () => {
  const { result, calls } = run({ base: null });
  const proof = await result;
  assert.equal(proof.proven, false);
  assert.equal(proof.without.method, "none");
  assert.ok(!calls.some((c) => c.startsWith("worktree")));
});

test("an unknown --base is an error", async () => {
  await assert.rejects(run({}, { base: "nope" }).result, /unknown/);
});
