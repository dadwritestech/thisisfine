import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOME_ENV, STATE_DIR } from "./types.ts";

/**
 * `~/.thisisfine`, outside every repo the agent works in. The key lives here
 * so that "edit the ledger" is not enough to forge a lock: the agent would
 * also have to go looking for a file it has no reason to know about, and the
 * guard denies Bash commands that name this directory.
 */
export function homeDir(): string {
  return process.env[HOME_ENV] || join(homedir(), STATE_DIR);
}

export function loadOrCreateKey(home: string = homeDir()): Buffer {
  const path = join(home, "key");
  if (existsSync(path)) {
    const hex = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    throw new Error(`${path} is not a 64-character hex key. Delete it to create a new one (existing locks will then fail to verify).`);
  }
  mkdirSync(home, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key.toString("hex") + "\n", { mode: 0o600 });
  return key;
}

/** Short public fingerprint of a key, stored on records so "signed elsewhere" is distinguishable from "forged". */
export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

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

function mac(record: { sig: string }, key: Buffer): string {
  const { sig: _sig, ...rest } = record;
  return createHmac("sha256", key).update(canonical(rest)).digest("hex");
}

export function signRecord<T extends { sig: string }>(record: T, key: Buffer): T {
  return { ...record, sig: mac(record, key) };
}

export function verifyRecord(record: { sig: string }, key: Buffer): boolean {
  if (typeof record.sig !== "string" || !/^[0-9a-f]{64}$/.test(record.sig)) return false;
  return timingSafeEqual(Buffer.from(record.sig, "hex"), Buffer.from(mac(record, key), "hex"));
}
