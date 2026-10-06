import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePrompt } from "../src/prompt.ts";
import { checkSignature, loadOrCreateSigner, publicKeyEntry } from "../src/sign.ts";
import { defaultState } from "../src/state.ts";
import type { LockRecord, RetireRecord } from "../src/types.ts";
import { lock, proposal, tempDir } from "./helpers.ts";

const signer = loadOrCreateSigner(tempDir());
const keyring = new Map([[signer.id, publicKeyEntry(signer.publicPem, { name: "sam", file: null, local: true })]]);
const base = { promptId: "pid-1", sessionId: "sess-1", transcriptPath: "/t.jsonl", now: "2026-10-04T12:00:00.000Z", signer, hashOf: () => "abcdabcdabcdabcd" };

test("y with a pending proposal appends a signed lock and tells both sides", () => {
  const d = decidePrompt([proposal()], defaultState(), { ...base, prompt: "y" });
  assert.equal(d.append.length, 1);
  const l = d.append[0] as LockRecord;
  assert.equal(l.kind, "lock");
  assert.equal(l.number, 1);
  assert.equal(l.words, "y");
  assert.equal(l.promptId, "pid-1");
  assert.equal(l.proposal, "p1");
  assert.equal(checkSignature(l, keyring), "valid");
  assert.equal(l.alg, "ed25519");
  assert.equal(l.keyId, signer.id);
  assert.match(d.systemMessage, /🔒 Locked promise #1 "Badge shows the cart count"/);
  assert.match(d.additionalContext, /#1 is now locked/);
});

test("y locks every pending proposal", () => {
  const d = decidePrompt([proposal(), proposal({ id: "p2", number: 2, sentence: "Logo links home" })], defaultState(), { ...base, prompt: "yes lock them" });
  assert.deepEqual(d.append.map((r) => r.kind), ["lock", "lock"]);
});

test("anything else dismisses pending proposals", () => {
  const d = decidePrompt([proposal()], defaultState(), { ...base, prompt: "yes but make it blue" });
  assert.deepEqual(d.append.map((r) => r.kind), ["dismiss"]);
  assert.match(d.additionalContext, /did not say yes to proposal #1/);
  assert.match(d.systemMessage, /not locked/i);
});

test("machine-started turns and slash commands change nothing", () => {
  for (const prompt of ["<task-notification>x</task-notification>", "/promises"]) {
    const d = decidePrompt([proposal()], defaultState(), { ...base, prompt });
    assert.deepEqual(d.append, []);
    assert.equal(d.additionalContext, "");
  }
});

test("a check edited after proposing is not locked", () => {
  const d = decidePrompt([proposal()], defaultState(), { ...base, prompt: "y", hashOf: () => "ffffffffffffffff" });
  assert.deepEqual(d.append.map((r) => r.kind), ["dismiss"]);
  assert.match(d.systemMessage, /changed after it was proposed/);
});

test("y to a retire proposal appends a signed retire", () => {
  const recs = [proposal(), lock(), proposal({ id: "p2", action: "retire", reason: "redesign" })];
  const d = decidePrompt(recs, defaultState(), { ...base, prompt: "ok" });
  const r = d.append[0] as RetireRecord;
  assert.equal(r.kind, "retire");
  assert.equal(r.number, 1);
  assert.equal(r.reason, "redesign");
  assert.equal(checkSignature(r, keyring), "valid");
  assert.match(d.systemMessage, /Retired promise #1/);
});

test("approval nudges once, then stays quiet for 5 prompts", () => {
  let s = defaultState();
  const d1 = decidePrompt([], s, { ...base, prompt: "perfect" });
  assert.match(d1.additionalContext, /offer to lock it in as promise #1/);
  s = d1.state;
  for (let i = 0; i < 4; i++) {
    const d = decidePrompt([], s, { ...base, prompt: "works!" });
    assert.equal(d.additionalContext, "", `prompt ${i}`);
    s = d.state;
  }
  assert.match(decidePrompt([], s, { ...base, prompt: "lgtm" }).additionalContext, /offer to lock/);
});

test("a y with nothing pending is just a message", () => {
  const d = decidePrompt([], defaultState(), { ...base, prompt: "y" });
  assert.deepEqual(d.append, []);
  assert.equal(d.systemMessage, "");
});
