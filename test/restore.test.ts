import { test } from "node:test";
import assert from "node:assert/strict";
import { activePromises } from "../src/promises.ts";
import { restoredLedger } from "../src/restore.ts";
import type { SignedRecord } from "../src/types.ts";
import { lock, proposal, retire } from "./helpers.ts";

const v1 = lock({ sig: "a".repeat(64), checkHash: "1111111111111111" });
const v2 = lock({ proposal: "p3", sig: "b".repeat(64), checkHash: "2222222222222222" });
const r1 = retire({ number: 2, proposal: "p4", sig: "c".repeat(64) });
const l2 = lock({ proposal: "p2", number: 2, sentence: "Logo links home", check: ".thisisfine/checks/2-logo.spec.ts", sig: "d".repeat(64) });
const mirror: SignedRecord[] = [v1, l2, v2, r1];
const never = () => false;

test("a cut-off tail comes back as an append", () => {
  const ledger = [proposal(), v1, proposal({ id: "p2", number: 2 }), l2];
  const { records, restored } = restoredLedger(ledger, mirror, never);
  assert.deepEqual(records.slice(0, 4), ledger);
  assert.deepEqual(records.slice(4), [v2, r1]);
  assert.deepEqual(restored, [v2, r1]);
});

test("a deleted line from the middle goes back in its place, so the replacement still wins", () => {
  const ledger = [proposal(), proposal({ id: "p2", number: 2 }), l2, v2, r1];
  const { records } = restoredLedger(ledger, mirror, never);
  assert.ok(records.indexOf(v1) < records.indexOf(v2));
  const [p1] = activePromises(records);
  assert.equal(p1?.checkHash, "2222222222222222", "v2 is still the active lock");
});

test("a tampered local record is replaced by the mirror's copy", () => {
  const forged = { ...v2, sentence: "Badge exists somewhere" };
  const ledger = [proposal(), v1, l2, forged, r1];
  const { records, restored } = restoredLedger(ledger, mirror, (r) => r === forged);
  assert.equal(records.includes(forged), false);
  assert.deepEqual(restored, [v2]);
  assert.equal(records.indexOf(v2), records.indexOf(l2) + 1);
});

test("an empty ledger is rebuilt from the mirror", () => {
  assert.deepEqual(restoredLedger([], mirror, never).records, mirror);
});
