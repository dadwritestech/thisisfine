import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendRecord, ledgerPath, parseLedger, readLedger } from "../src/ledger.ts";
import type { DismissRecord } from "../src/types.ts";
import { lock, proposal, tempDir } from "./helpers.ts";

test("missing ledger reads as empty", () => {
  assert.deepEqual(readLedger(ledgerPath(tempDir())), []);
});

test("append then read round-trips", () => {
  const path = ledgerPath(tempDir());
  const d: DismissRecord = { kind: "dismiss", proposal: "p1", words: "no", at: "2026-10-04T10:01:00.000Z" };
  appendRecord(path, proposal());
  appendRecord(path, d);
  assert.deepEqual(readLedger(path), [proposal(), d]);
});

test("malformed line is reported with its line number", () => {
  const root = tempDir();
  const path = ledgerPath(root);
  appendRecord(path, proposal());
  appendFileSync(path, "{not json\n");
  assert.throws(() => readLedger(path), /line 2/);
});

test("unknown kind is rejected", () => {
  const path = ledgerPath(tempDir());
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, JSON.stringify({ kind: "approved", number: 1 }) + "\n");
  assert.throws(() => readLedger(path), /kind/);
});

test("lock without a signature is rejected", () => {
  const path = ledgerPath(tempDir());
  const { sig: _s, ...unsigned } = lock();
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, JSON.stringify(unsigned) + "\n");
  assert.throws(() => readLedger(path), /sig/);
});

test("a signed record's alg is absent (legacy HMAC) or ed25519, nothing else", () => {
  for (const [alg, ok] of [[undefined, true], ["ed25519", true], ["hmac", false], ["none", false]] as const) {
    const path = ledgerPath(tempDir());
    appendRecord(path, { ...lock(), alg } as unknown as ReturnType<typeof lock>);
    if (ok) assert.equal(readLedger(path).length, 1);
    else assert.throws(() => readLedger(path), /alg/);
  }
});

test("check path escaping the project is rejected", () => {
  const path = ledgerPath(tempDir());
  appendRecord(path, proposal({ check: "../../etc/passwd" }));
  assert.throws(() => readLedger(path), /check/);
});

test("blank lines are tolerated", () => {
  const path = ledgerPath(tempDir());
  appendRecord(path, proposal());
  appendFileSync(path, "\n\n");
  assert.equal(readLedger(path).length, 1);
});

test("parseLedger reads ledger text from anywhere (e.g. git show) and names the source on errors", () => {
  const text = JSON.stringify(proposal()) + "\n\n" + JSON.stringify(proposal({ id: "p2", number: 2 })) + "\n";
  assert.equal(parseLedger(text, "main:.thisisfine/promises.jsonl").length, 2);
  assert.throws(() => parseLedger("{nope\n", "main:.thisisfine/promises.jsonl"), /main:\.thisisfine\/promises\.jsonl line 1/);
});
