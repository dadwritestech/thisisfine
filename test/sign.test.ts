import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, keyIdOf, loadOrCreateKey, signRecord, verifyRecord } from "../src/sign.ts";
import { tempDir } from "./helpers.ts";

test("canonical JSON sorts keys at every depth", () => {
  assert.equal(canonical({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[{"x":2,"y":1}]},"b":1}');
});

test("key is created once (64 hex chars) and reused", () => {
  const home = tempDir();
  const k1 = loadOrCreateKey(home);
  const k2 = loadOrCreateKey(home);
  assert.equal(k1.toString("hex"), k2.toString("hex"));
  assert.match(readFileSync(join(home, "key"), "utf8").trim(), /^[0-9a-f]{64}$/);
  assert.match(keyIdOf(k1), /^[0-9a-f]{8}$/);
  assert.equal(keyIdOf(k1), keyIdOf(k2));
});

test("signed record verifies; any tampered field fails", () => {
  const key = loadOrCreateKey(tempDir());
  const rec = signRecord({ kind: "lock", number: 3, sentence: "badge shows count", words: "y", sig: "" }, key);
  assert.match(rec.sig, /^[0-9a-f]{64}$/);
  assert.equal(verifyRecord(rec, key), true);
  assert.equal(verifyRecord({ ...rec, sentence: "badge shows nothing" } as typeof rec, key), false);
  assert.equal(verifyRecord({ ...rec, number: 4 } as typeof rec, key), false);
  assert.equal(verifyRecord({ ...rec, sig: "0".repeat(64) }, key), false);
  assert.equal(verifyRecord({ ...rec, sig: "short" }, key), false);
});

test("a different key does not verify", () => {
  const rec = signRecord({ kind: "lock", sig: "" }, loadOrCreateKey(tempDir()));
  assert.equal(verifyRecord(rec, loadOrCreateKey(tempDir())), false);
});
