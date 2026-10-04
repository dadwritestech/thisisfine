import { test } from "node:test";
import assert from "node:assert/strict";
import { integrityProblems } from "../src/integrity.ts";
import { appendMirror, readMirror, mirrorCheckContent } from "../src/mirror.ts";
import { keyIdOf, loadOrCreateKey, signRecord } from "../src/sign.ts";
import { lock, proposal, retire, tempDir } from "./helpers.ts";

const key = loadOrCreateKey(tempDir());
const keyId = keyIdOf(key);
const signedLock = signRecord(lock({ keyId }), key);
const ok = { key, keyId, hashOf: () => "abcdabcdabcdabcd" };

test("mirror round-trips signed records and check contents per project", () => {
  const home = tempDir();
  const root = tempDir();
  appendMirror(root, signedLock, "test('x', () => {})\n", home);
  assert.deepEqual(readMirror(root, home), [signedLock]);
  assert.equal(mirrorCheckContent(root, signedLock.checkHash, home), "test('x', () => {})\n");
  assert.deepEqual(readMirror(tempDir(), home), [], "other projects are separate");
});

test("a clean ledger has no problems", () => {
  assert.deepEqual(integrityProblems({ records: [proposal(), signedLock], mirror: [signedLock], ...ok }), []);
});

test("an edited lock fails its signature", () => {
  const edited = { ...signedLock, sentence: "Badge exists" };
  const problems = integrityProblems({ records: [proposal(), edited], mirror: [], ...ok });
  assert.match(problems.join("\n"), /#1.*signature/);
});

test("a changed or deleted check is reported", () => {
  assert.match(integrityProblems({ records: [signedLock], mirror: [], ...ok, hashOf: () => "ffffffffffffffff" }).join(), /#1's check was changed after you confirmed it/);
  assert.match(integrityProblems({ records: [signedLock], mirror: [], ...ok, hashOf: () => "missing" }).join(), /#1's check was deleted/);
});

test("a lock in the mirror but not in the repo is reported", () => {
  assert.match(integrityProblems({ records: [], mirror: [signedLock], ...ok }).join(), /#1.*missing from \.thisisfine\/promises\.jsonl/);
});

test("a retire signed elsewhere cannot retire a promise this machine locked", () => {
  const foreign = retire({ keyId: "deadbeef" });
  assert.match(integrityProblems({ records: [signedLock, foreign], mirror: [signedLock], ...ok }).join(), /#1 was retired by a record this machine didn't sign/);
});

test("locks signed elsewhere (a teammate's) are accepted", () => {
  const theirs = lock({ number: 2, keyId: "deadbeef", checkHash: "abcdabcdabcdabcd" });
  assert.deepEqual(integrityProblems({ records: [signedLock, theirs], mirror: [signedLock], ...ok }), []);
});
