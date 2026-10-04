import { test } from "node:test";
import assert from "node:assert/strict";
import { activePromises, foldPromises, nextNumber, pendingProposals } from "../src/promises.ts";
import { lock, proposal, retire } from "./helpers.ts";

test("a proposal alone is pending, not a promise", () => {
  const recs = [proposal()];
  assert.equal(foldPromises(recs).size, 0);
  assert.deepEqual(pendingProposals(recs).map((p) => p.id), ["p1"]);
});

test("proposal + lock = active promise, nothing pending", () => {
  const recs = [proposal(), lock()];
  const p = foldPromises(recs).get(1);
  assert.equal(p?.status, "active");
  assert.equal(p?.sentence, "Badge shows the cart count");
  assert.deepEqual(pendingProposals(recs), []);
});

test("re-lock of the same number replaces it (newest wins)", () => {
  const recs = [proposal(), lock(), proposal({ id: "p2", check: ".thisisfine/checks/1-badge-v2.spec.ts" }),
    lock({ proposal: "p2", check: ".thisisfine/checks/1-badge-v2.spec.ts" })];
  assert.equal(foldPromises(recs).get(1)?.check, ".thisisfine/checks/1-badge-v2.spec.ts");
  assert.equal(activePromises(recs).length, 1);
});

test("retire makes a promise retired, and it leaves the active list", () => {
  const recs = [proposal(), lock(), proposal({ id: "p2", action: "retire", reason: "badge removed by design" }), retire()];
  assert.equal(foldPromises(recs).get(1)?.status, "retired");
  assert.equal(foldPromises(recs).get(1)?.retire?.reason, "badge removed by design");
  assert.deepEqual(activePromises(recs), []);
});

test("dismiss clears a pending proposal", () => {
  const recs = [proposal(), { kind: "dismiss" as const, proposal: "p1", words: "not yet", at: "t" }];
  assert.deepEqual(pendingProposals(recs), []);
});

test("a newer unanswered proposal for the same number supersedes the older one", () => {
  const recs = [proposal(), proposal({ id: "p1b", check: ".thisisfine/checks/1-better.spec.ts" })];
  assert.deepEqual(pendingProposals(recs).map((p) => p.id), ["p1b"]);
});

test("nextNumber counts pending proposals and locks", () => {
  assert.equal(nextNumber([]), 1);
  assert.equal(nextNumber([proposal()]), 2);
  assert.equal(nextNumber([proposal(), lock(), proposal({ id: "p5", number: 5 })]), 6);
});
