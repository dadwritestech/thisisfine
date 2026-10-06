import { test } from "node:test";
import assert from "node:assert/strict";
import { behaviourDiff } from "../src/diff.ts";
import type { DiffInput } from "../src/diff.ts";
import { keyIdOf, signRecord } from "../src/sign.ts";
import type { LedgerRecord } from "../src/types.ts";
import { lock, proposal, retire } from "./helpers.ts";

const key = Buffer.alloc(32, 7);
const keyId = keyIdOf(key);
const HASH = "abcdabcdabcdabcd";

const lock1 = lock({ words: "y, perfect" });
const lock2 = lock({ proposal: "p2", number: 2, sentence: "Logged-out visitors go to /login", check: ".thisisfine/checks/2-login.spec.ts" });

function diff(base: LedgerRecord[], head: LedgerRecord[], over: Partial<DiffInput> = {}) {
  return behaviourDiff({ base, head, hashOf: () => HASH, key, keyId, report: null, ...over });
}

test("a promise locked on the branch is listed as locked", () => {
  const d = diff([], [proposal(), lock1]);
  assert.deepEqual(d.locked.map((p) => p.number), [1]);
  assert.equal(d.retired.length + d.replaced.length + d.dropped.length, 0);
  assert.equal(d.ok, true);
});

test("an unchanged promise is not news", () => {
  const d = diff([proposal(), lock1], [proposal(), lock1]);
  assert.equal(d.locked.length, 0);
  assert.equal(d.newSigned.length, 0);
});

test("a promise retired on the branch is listed with its reason", () => {
  const r = retire({ reason: "badge removed by design" });
  const d = diff([proposal(), lock1], [proposal(), lock1, r]);
  assert.equal(d.retired.length, 1);
  assert.equal(d.retired[0]!.retire?.reason, "badge removed by design");
});

test("re-locking a number with a new check is a replacement, old and new", () => {
  const relock = lock({ proposal: "p9", sentence: "Badge shows the item count", checkHash: HASH });
  const d = diff([proposal(), lock1], [proposal(), lock1, relock]);
  assert.equal(d.replaced.length, 1);
  assert.equal(d.replaced[0]!.before.sentence, "Badge shows the cart count");
  assert.equal(d.replaced[0]!.after.sentence, "Badge shows the item count");
  assert.equal(d.locked.length, 0);
});

test("a retired promise locked again is locked, not replaced", () => {
  const base = [proposal(), lock1, retire()];
  const d = diff(base, [...base, lock({ proposal: "p9" })]);
  assert.deepEqual(d.locked.map((p) => p.number), [1]);
  assert.equal(d.replaced.length, 0);
});

test("proposals still waiting for a human are pending, not locked", () => {
  const d = diff([], [proposal({ number: 3, sentence: "Search finds a coffee by name" })]);
  assert.equal(d.locked.length, 0);
  assert.equal(d.pending.length, 1);
  assert.equal(d.pending[0]!.sentence, "Search finds a coffee by name");
});

test("a pending retirement carries the promise's sentence", () => {
  const ask = proposal({ id: "p5", action: "retire", reason: "redesign", sentence: "Badge shows the cart count" });
  const d = diff([proposal(), lock1], [proposal(), lock1, ask]);
  assert.equal(d.pending[0]!.proposal.action, "retire");
  assert.equal(d.pending[0]!.sentence, "Badge shows the cart count");
});

test("base records missing from head mean the append-only ledger was rewritten", () => {
  const d = diff([proposal(), lock1], [proposal()]);
  assert.equal(d.dropped.length, 1);
  assert.equal(d.dropped[0]!.kind, "lock");
  assert.equal(d.ok, false);
});

test("a locked check whose file no longer matches the signed hash is edited", () => {
  const d = diff([proposal(), lock1], [proposal(), lock1], { hashOf: () => "ffffffffffffffff" });
  assert.deepEqual(d.edited.map((p) => p.number), [1]);
  assert.equal(d.ok, false);
});

test("check outcomes sort promises into kept, flaky and broken; a missing outcome is broken", () => {
  const records = [proposal(), lock1, proposal({ id: "p2", number: 2 }), lock2, proposal({ id: "p3", number: 3 }), lock({ proposal: "p3", number: 3, check: ".thisisfine/checks/3-x.spec.ts" })];
  const d = diff(records, records, {
    report: {
      ran: true, reason: "",
      outcomes: [
        { check: lock1.check, status: "failed", message: "Expected: \"2\"", screenshot: null },
        { check: lock2.check, status: "flaky", message: "", screenshot: null }
      ]
    }
  });
  assert.deepEqual(d.broken.map((b) => b.promise.number), [1, 3]);
  assert.equal(d.broken[1]!.outcome.status, "missing");
  assert.deepEqual(d.flaky.map((p) => p.number), [2]);
  assert.equal(d.ok, false);
});

test("all outcomes passing means kept and ok", () => {
  const d = diff([], [proposal(), lock1], { report: { ran: true, reason: "", outcomes: [{ check: lock1.check, status: "passed", message: "", screenshot: null }] } });
  assert.deepEqual(d.kept.map((p) => p.number), [1]);
  assert.equal(d.ok, true);
});

test("checks that couldn't run are a problem, not a pass", () => {
  const d = diff([], [proposal(), lock1], { report: { ran: false, reason: "the app didn't start", outcomes: [] } });
  assert.equal(d.notRun, "the app didn't start");
  assert.equal(d.kept.length + d.broken.length, 0);
  assert.equal(d.ok, false);
});

test("without a report nothing is claimed kept or broken", () => {
  const d = diff([], [proposal(), lock1]);
  assert.equal(d.kept.length + d.broken.length + d.flaky.length, 0);
  assert.equal(d.notRun, null);
});

test("new confirmations signed elsewhere are unverifiable here, not failures", () => {
  const d = diff([], [proposal(), lock1]);
  assert.equal(d.newSigned.length, 1);
  assert.equal(d.unverifiable.length, 1);
  assert.equal(d.badSignatures.length, 0);
  assert.equal(d.ok, true);
});

test("new confirmations signed with this machine's key are verified, and a bad one fails", () => {
  const good = signRecord(lock({ keyId }), key);
  assert.equal(diff([], [proposal(), good]).unverifiable.length, 0);
  const forged = { ...good, words: "yes" };
  const d = diff([], [proposal(), forged]);
  assert.equal(d.badSignatures.length, 1);
  assert.equal(d.ok, false);
});
