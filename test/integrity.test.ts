import { test } from "node:test";
import assert from "node:assert/strict";
import { integrityProblems } from "../src/integrity.ts";
import { appendMirror, readMirror, mirrorCheckContent } from "../src/mirror.ts";
import { randomBytes } from "node:crypto";
import { hmacSign, keyIdOf, legacyKeyEntry, loadOrCreateSigner, publicKeyEntry, signRecord } from "../src/sign.ts";
import type { Keyring, KnownKey } from "../src/sign.ts";
import { lock, proposal, retire, tempDir } from "./helpers.ts";

const mine = loadOrCreateSigner(tempDir());
const alice = loadOrCreateSigner(tempDir());
const mineKey = publicKeyEntry(mine.publicPem, { name: "sam", file: ".thisisfine/keys/sam.pub", local: true });
const aliceKey = publicKeyEntry(alice.publicPem, { name: "alice", file: ".thisisfine/keys/alice.pub", local: false });
const ring = (...keys: KnownKey[]): Keyring => new Map(keys.map((k) => [k.id, k]));
const signedLock = signRecord(lock(), mine);
const ok = { keyring: ring(mineKey, aliceKey), hashOf: () => "abcdabcdabcdabcd" };

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
  const unknown = lock({ number: 2, keyId: "deadbeef", checkHash: "abcdabcdabcdabcd" });
  const committed = signRecord(lock({ number: 3 }), alice);
  assert.deepEqual(integrityProblems({ records: [signedLock, unknown, committed], mirror: [signedLock], ...ok }), []);
});

test("a teammate's lock that doesn't match their committed key is reported, naming the key", () => {
  const edited = { ...signRecord(lock({ number: 2 }), alice), sentence: "Badge exists" };
  assert.match(integrityProblems({ records: [signedLock, edited], mirror: [signedLock], ...ok }).join(), /#2: the lock record's signature doesn't match alice\.pub/);
});

test("a teammate's committed key still can't retire a promise this machine locked", () => {
  const theirs = signRecord(retire(), alice);
  assert.match(integrityProblems({ records: [signedLock, theirs], mirror: [signedLock], ...ok }).join(), /#1 was retired by a record this machine didn't sign \(alice\.pub\)/);
});

test("a key file swapped for another key leaves this machine's locks unverifiable elsewhere, which is reported", () => {
  const uncommitted = { ...mineKey, file: null };
  assert.match(integrityProblems({ records: [signedLock], mirror: [signedLock], ...ok, keyring: ring(uncommitted, aliceKey) }).join(),
    new RegExp(`this machine's public key \\(${mine.id}\\) is missing from \\.thisisfine/keys/, so nobody else can verify #1`));
  assert.deepEqual(integrityProblems({ records: [], mirror: [], ...ok, keyring: ring(uncommitted) }), [], "nothing signed yet: nothing to publish");
});

test("legacy HMAC locks from this machine still verify, and still detect edits", () => {
  const key = randomBytes(32);
  const legacy = hmacSign(lock({ keyId: keyIdOf(key) }), key);
  const keyring = ring(legacyKeyEntry(key), mineKey);
  assert.deepEqual(integrityProblems({ records: [legacy], mirror: [legacy], ...ok, keyring }), []);
  assert.match(integrityProblems({ records: [{ ...legacy, sentence: "x" }], mirror: [], ...ok, keyring }).join(), /#1.*signature/);
  const forgedRetire = signRecord(retire(), alice);
  assert.match(integrityProblems({ records: [legacy, forgedRetire], mirror: [legacy], ...ok, keyring: ring(legacyKeyEntry(key), aliceKey) }).join(), /#1 was retired/);
});
