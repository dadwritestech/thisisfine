import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonical, checkSignature, hmacSign, keyIdOf, legacyKeyEntry, loadLegacyKey, loadOrCreateSigner, loadSigner,
  publicKeyEntry, publicKeyId, signRecord
} from "../src/sign.ts";
import type { Keyring } from "../src/sign.ts";
import { tempDir } from "./helpers.ts";

const ring = (...entries: ReturnType<typeof publicKeyEntry>[]): Keyring => new Map(entries.map((e) => [e.id, e]));

test("canonical JSON sorts keys at every depth", () => {
  assert.equal(canonical({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[{"x":2,"y":1}]},"b":1}');
});

test("a signer is created once (private key private to the home dir) and reused", () => {
  const home = tempDir();
  assert.equal(loadSigner(home), null, "loading never creates a key");
  const s1 = loadOrCreateSigner(home);
  const s2 = loadOrCreateSigner(home);
  assert.equal(s1.id, s2.id);
  assert.match(s1.id, /^[0-9a-f]{16}$/);
  assert.equal(s1.id, publicKeyId(s1.publicPem));
  assert.match(s1.publicPem, /^-----BEGIN PUBLIC KEY-----/);
  assert.match(readFileSync(join(home, "signing-key.pem"), "utf8"), /PRIVATE KEY/);
  assert.equal(loadSigner(home)?.id, s1.id);
  assert.equal(existsSync(join(home, "key")), false, "no HMAC key is made any more");
});

test("an Ed25519-signed record verifies with only the public key; any tampered field fails", () => {
  const signer = loadOrCreateSigner(tempDir());
  const rec = signRecord({ kind: "lock", number: 3, sentence: "badge shows count", words: "y", keyId: "", sig: "" }, signer);
  assert.equal(rec.alg, "ed25519");
  assert.equal(rec.keyId, signer.id);
  assert.match(rec.sig, /^[0-9a-f]{128}$/);
  const keys = ring(publicKeyEntry(signer.publicPem, { name: "sam", file: ".thisisfine/keys/sam.pub", local: false }));
  assert.equal(checkSignature(rec, keys), "valid");
  assert.equal(checkSignature({ ...rec, sentence: "badge shows nothing" }, keys), "invalid");
  assert.equal(checkSignature({ ...rec, number: 4 }, keys), "invalid");
  assert.equal(checkSignature({ ...rec, sig: "0".repeat(128) }, keys), "invalid");
  assert.equal(checkSignature({ ...rec, sig: "short" }, keys), "invalid");
  assert.equal(checkSignature({ ...rec, alg: undefined }, keys), "invalid", "can't downgrade an Ed25519 record to HMAC");
});

test("a record signed by a key the keyring doesn't have is unknown, not invalid", () => {
  const rec = signRecord({ kind: "lock", keyId: "", sig: "" }, loadOrCreateSigner(tempDir()));
  const other = loadOrCreateSigner(tempDir());
  assert.equal(checkSignature(rec, ring(publicKeyEntry(other.publicPem, { name: "x", file: null, local: true }))), "unknown");
});

test("a swapped public key file gets a different id, so it can't stand in for the signer", () => {
  const a = loadOrCreateSigner(tempDir());
  const b = loadOrCreateSigner(tempDir());
  assert.notEqual(publicKeyId(a.publicPem), publicKeyId(b.publicPem));
});

test("legacy HMAC records still verify with the old key, which is read but never created", () => {
  const home = tempDir();
  assert.equal(loadLegacyKey(home), null);
  const key = randomBytes(32);
  writeFileSync(join(home, "key"), key.toString("hex") + "\n");
  assert.deepEqual(loadLegacyKey(home), key);
  assert.match(keyIdOf(key), /^[0-9a-f]{8}$/);

  const rec = hmacSign({ kind: "lock", number: 3, keyId: keyIdOf(key), sig: "" }, key);
  assert.match(rec.sig, /^[0-9a-f]{64}$/);
  const keys: Keyring = new Map([[keyIdOf(key), legacyKeyEntry(key)]]);
  assert.equal(checkSignature(rec, keys), "valid");
  assert.equal(checkSignature({ ...rec, number: 4 }, keys), "invalid");
  assert.equal(checkSignature({ ...rec, alg: "ed25519" }, keys), "invalid");
  assert.equal(checkSignature(rec, new Map()), "unknown");
});

test("a malformed legacy key file is an error, not a silent new key", () => {
  const home = tempDir();
  writeFileSync(join(home, "key"), "nope\n");
  assert.throws(() => loadLegacyKey(home), /64-character hex/);
});
