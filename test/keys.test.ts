import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildKeyring, keyFileName, publishPublicKey, readPublicKeys } from "../src/keys.ts";
import { keyIdOf, loadOrCreateSigner } from "../src/sign.ts";
import { put, tempDir } from "./helpers.ts";

test("publishing writes the public key (never the private one) under .thisisfine/keys/, once", () => {
  const root = tempDir();
  const signer = loadOrCreateSigner(tempDir());
  const first = publishPublicKey(root, signer, "sam");
  assert.deepEqual(first, { file: ".thisisfine/keys/sam.pub", created: true });
  const text = readFileSync(join(root, first.file), "utf8");
  assert.equal(text, signer.publicPem);
  assert.doesNotMatch(text, /PRIVATE/);
  assert.deepEqual(publishPublicKey(root, signer, "someone-else"), { file: ".thisisfine/keys/sam.pub", created: false }, "found by content, not by name");
});

test("a name already taken by another key gets the key id appended", () => {
  const root = tempDir();
  publishPublicKey(root, loadOrCreateSigner(tempDir()), "dev");
  const second = loadOrCreateSigner(tempDir());
  assert.equal(publishPublicKey(root, second, "dev").file, `.thisisfine/keys/dev-${second.id.slice(0, 8)}.pub`);
});

test("key file names are safe and never empty", () => {
  assert.equal(keyFileName("Sam D"), "sam-d");
  assert.equal(keyFileName("../../etc"), "etc");
  assert.equal(keyFileName("???"), "key");
});

test("reading public keys identifies each by content and reports unreadable files", () => {
  const root = tempDir();
  const a = loadOrCreateSigner(tempDir());
  publishPublicKey(root, a, "alice");
  put(root, ".thisisfine/keys/broken.pub", "not a key\n");
  put(root, ".thisisfine/keys/README.md", "ignored\n");
  const { keys, errors } = readPublicKeys(root);
  assert.deepEqual(keys.map((k) => [k.id, k.name, k.file]), [[a.id, "alice", ".thisisfine/keys/alice.pub"]]);
  assert.match(errors.join(), /broken\.pub/);
  assert.deepEqual(readPublicKeys(tempDir()), { keys: [], errors: [] }, "no keys dir is fine");
});

test("the keyring marks this machine's key local, whether or not it is committed", () => {
  const root = tempDir();
  const home = tempDir();
  const mine = loadOrCreateSigner(home);
  const theirs = loadOrCreateSigner(tempDir());
  publishPublicKey(root, theirs, "alice");

  let ring = buildKeyring(root, home);
  assert.deepEqual([...ring.values()].map((k) => [k.id, k.local, k.file]), [
    [theirs.id, false, ".thisisfine/keys/alice.pub"],
    [mine.id, true, null]
  ]);

  publishPublicKey(root, mine, "sam");
  ring = buildKeyring(root, home);
  assert.deepEqual(ring.get(mine.id) && [ring.get(mine.id)!.local, ring.get(mine.id)!.file], [true, ".thisisfine/keys/sam.pub"]);
});

test("the keyring includes a legacy HMAC key when this machine has one, and never creates keys", () => {
  const home = tempDir();
  const legacy = randomBytes(32);
  writeFileSync(join(home, "key"), legacy.toString("hex"));
  const ring = buildKeyring(tempDir(), home);
  assert.deepEqual([...ring.keys()], [keyIdOf(legacy)]);
  assert.equal(ring.get(keyIdOf(legacy))!.alg, "hmac");
  assert.equal(buildKeyring(tempDir(), tempDir()).size, 0);
});
