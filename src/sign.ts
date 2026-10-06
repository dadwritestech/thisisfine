import {
  createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign, timingSafeEqual, verify
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME_ENV, STATE_DIR } from "./types.ts";

/**
 * `~/.thisisfine`, outside every repo the agent works in. The private key
 * lives here so that "edit the ledger" is not enough to forge a lock: the
 * agent would also have to go looking for a file it has no reason to know
 * about, and the guard denies Bash commands that name this directory.
 */
export function homeDir(): string {
  return process.env[HOME_ENV] || join(homedir(), STATE_DIR);
}

// ── Ed25519: what new locks are signed with ───────────────────────────────

/**
 * The private half stays in the home dir; the public half is committed to
 * `.thisisfine/keys/`, so a teammate or CI can verify a lock without being
 * able to sign one.
 */
export interface Signer {
  id: string;
  privateKey: KeyObject;
  publicPem: string;
}

const SIGNING_KEY = "signing-key.pem";

function signerFrom(privateKey: KeyObject): Signer {
  const publicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  return { id: publicKeyId(publicPem), privateKey, publicPem };
}

/** This machine's signer, or null if it has never signed anything. Never creates one. */
export function loadSigner(home: string = homeDir()): Signer | null {
  const path = join(home, SIGNING_KEY);
  if (!existsSync(path)) return null;
  const key = createPrivateKey(readFileSync(path, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${path} is not an Ed25519 private key.`);
  return signerFrom(key);
}

export function loadOrCreateSigner(home: string = homeDir()): Signer {
  const existing = loadSigner(home);
  if (existing) return existing;
  mkdirSync(home, { recursive: true });
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(join(home, SIGNING_KEY), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return signerFrom(privateKey);
}

/**
 * Fingerprint of a public key's *content*, so a key file can't be renamed
 * or swapped into another key's place. 64 bits: grinding a keypair whose id
 * collides with a teammate's is out of reach, unlike the 32-bit legacy ids.
 */
export function publicKeyId(pem: string): string {
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

// ── HMAC: how locks used to be signed; still verified, never made ──

/** The pre-Ed25519 per-machine key, if this machine has one. Never creates it. */
export function loadLegacyKey(home: string = homeDir()): Buffer | null {
  const path = join(home, "key");
  if (!existsSync(path)) return null;
  const hex = readFileSync(path, "utf8").trim();
  if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  throw new Error(`${path} is not a 64-character hex key. It only verifies locks signed before thisisfine switched to Ed25519; restore it from a backup or delete it (those locks then can't be checked).`);
}

/** Short public fingerprint of a legacy key, stored on records so "signed elsewhere" is distinguishable from "forged". */
export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

// ── records ───────────────────────────────────────────────────────────────

/** JSON with keys sorted at every depth, so the same record always signs the same bytes. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

interface Signable {
  sig: string;
  keyId: string;
  alg?: "ed25519";
}

/** The signed bytes: everything but `sig`. `alg` is included, so a record can't be downgraded to HMAC. */
function payload(record: Signable): Buffer {
  const { sig: _sig, ...rest } = record;
  return Buffer.from(canonical(rest), "utf8");
}

function mac(record: Signable, key: Buffer): string {
  return createHmac("sha256", key).update(payload(record)).digest("hex");
}

export function signRecord<T extends Signable>(record: T, signer: Signer): T & { alg: "ed25519" } {
  const rec = { ...record, alg: "ed25519" as const, keyId: signer.id, sig: "" };
  return { ...rec, sig: sign(null, payload(rec), signer.privateKey).toString("hex") };
}

/** Legacy signing, kept so tests can make the records older versions wrote. */
export function hmacSign<T extends Signable>(record: T, key: Buffer): T {
  return { ...record, sig: mac(record, key) };
}

/**
 * A key this machine can check signatures with: a committed public key
 * (`file` set), this machine's own signer (`local`), or the legacy HMAC key.
 */
export interface KnownKey {
  id: string;
  alg: "ed25519" | "hmac";
  /** Who it belongs to, for people: the key file's name. */
  name: string;
  /** Root-relative path of the committed public key, or null if it isn't committed. */
  file: string | null;
  /** This machine holds the private half. */
  local: boolean;
  publicKey?: KeyObject;
  secret?: Buffer;
}

export type Keyring = Map<string, KnownKey>;

export function publicKeyEntry(pem: string, where: { name: string; file: string | null; local: boolean }): KnownKey {
  return { id: publicKeyId(pem), alg: "ed25519", publicKey: createPublicKey(pem), ...where };
}

export function legacyKeyEntry(key: Buffer): KnownKey {
  return { id: keyIdOf(key), alg: "hmac", name: "this machine's old HMAC key", file: null, local: true, secret: key };
}

export type SignatureCheck = "valid" | "invalid" | "unknown";

/**
 * "unknown" means no key here can check it (signed on a machine whose key
 * isn't committed): not evidence of forgery on its own. "invalid" is: the
 * key is known and the bytes don't match it.
 */
export function checkSignature<T extends Signable>(record: T, keyring: Keyring): SignatureCheck {
  const key = keyring.get(record.keyId);
  if (!key) return "unknown";
  if (typeof record.sig !== "string") return "invalid";
  if (key.alg === "hmac") {
    if (record.alg !== undefined || !/^[0-9a-f]{64}$/.test(record.sig) || !key.secret) return "invalid";
    return timingSafeEqual(Buffer.from(record.sig, "hex"), Buffer.from(mac(record, key.secret), "hex")) ? "valid" : "invalid";
  }
  if (record.alg !== "ed25519" || !/^[0-9a-f]{128}$/.test(record.sig) || !key.publicKey) return "invalid";
  return verify(null, payload(record), key.publicKey, Buffer.from(record.sig, "hex")) ? "valid" : "invalid";
}
