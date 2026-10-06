import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir, legacyKeyEntry, loadLegacyKey, loadSigner, publicKeyEntry } from "./sign.ts";
import type { Keyring, KnownKey, Signer } from "./sign.ts";
import { STATE_DIR } from "./types.ts";

/**
 * `.thisisfine/keys/<name>.pub`: committed public keys, one per person or
 * machine that has confirmed a promise. Anyone with the repo can verify a
 * lock against them; nobody can sign with them.
 *
 * This directory is a trust anchor, so it is reviewed like code: a key
 * added here vouches for every lock it signs. The guard refuses agent
 * writes to it, and a key is identified by its content's fingerprint, never
 * its file name, so renaming or swapping a file can't impersonate a signer.
 */
export const KEYS_DIR = `${STATE_DIR}/keys`;

export function keyFileName(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return safe || "key";
}

export function readPublicKeys(root: string): { keys: KnownKey[]; errors: string[] } {
  const dir = join(root, KEYS_DIR);
  if (!existsSync(dir)) return { keys: [], errors: [] };
  const keys: KnownKey[] = [];
  const errors: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".pub")).sort()) {
    const file = `${KEYS_DIR}/${f}`;
    try {
      const entry = publicKeyEntry(readFileSync(join(dir, f), "utf8"), { name: f.slice(0, -4), file, local: false });
      if (entry.alg !== "ed25519" || entry.publicKey?.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
      keys.push(entry);
    } catch (e) {
      errors.push(`${file} is not a readable Ed25519 public key (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return { keys, errors };
}

/**
 * Writes this machine's public key into the repo, unless a file with the
 * same key is already there. Run by the hook that signs a lock, so the key
 * a lock needs is always next to it.
 */
export function publishPublicKey(root: string, signer: Signer, name: string): { file: string; created: boolean } {
  const existing = readPublicKeys(root).keys.find((k) => k.id === signer.id);
  if (existing?.file) return { file: existing.file, created: false };
  let base = keyFileName(name);
  if (existsSync(join(root, KEYS_DIR, `${base}.pub`))) base = `${base}-${signer.id.slice(0, 8)}`;
  mkdirSync(join(root, KEYS_DIR), { recursive: true });
  writeFileSync(join(root, KEYS_DIR, `${base}.pub`), signer.publicPem);
  return { file: `${KEYS_DIR}/${base}.pub`, created: true };
}

/**
 * Every key this machine can check signatures with: the committed public
 * keys, plus this machine's own (marked `local`, and listed even if its
 * file was deleted from the repo, so its locks stay checkable here), plus
 * the legacy HMAC key if this machine signed locks before Ed25519.
 * Reads only: CI and teammates verify without ever getting a key made.
 */
export function buildKeyring(root: string, home: string = homeDir()): Keyring {
  const ring: Keyring = new Map(readPublicKeys(root).keys.map((k) => [k.id, k]));
  const signer = loadSigner(home);
  if (signer) {
    const committed = ring.get(signer.id);
    ring.set(signer.id, committed
      ? { ...committed, local: true }
      : publicKeyEntry(signer.publicPem, { name: "this machine", file: null, local: true }));
  }
  const legacy = loadLegacyKey(home);
  if (legacy) {
    const entry = legacyKeyEntry(legacy);
    ring.set(entry.id, entry);
  }
  return ring;
}
