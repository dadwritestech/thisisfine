import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendRecord, readLedger } from "./ledger.ts";
import { homeDir } from "./sign.ts";
import type { SignedRecord } from "./types.ts";

/**
 * A second copy of every signed record, in the home directory, outside the
 * repo. `git checkout .`, `git stash`, or a hand-deleted line can make a
 * lock vanish from the repo's ledger; it can't make it vanish from here.
 * Locked check files are kept too (by hash), so `thisisfine restore` can put
 * back exactly what the human confirmed.
 */
export function projectId(root: string): string {
  const abs = resolve(root);
  const norm = process.platform === "win32" ? abs.toLowerCase() : abs;
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

export function mirrorDir(root: string, home: string = homeDir()): string {
  return join(home, "projects", projectId(root));
}

export function appendMirror(root: string, record: SignedRecord, checkContent: string | null, home: string = homeDir()): void {
  const dir = mirrorDir(root, home);
  appendRecord(join(dir, "ledger.jsonl"), record);
  writeFileSync(join(dir, "root.txt"), resolve(root) + "\n");
  if (record.kind === "lock" && checkContent !== null) {
    mkdirSync(join(dir, "checks"), { recursive: true });
    writeFileSync(join(dir, "checks", `${record.checkHash}.spec.ts`), checkContent);
  }
}

/** A corrupt mirror reads as empty rather than wedging every stop. */
export function readMirror(root: string, home: string = homeDir()): SignedRecord[] {
  try {
    return readLedger(join(mirrorDir(root, home), "ledger.jsonl"))
      .filter((r): r is SignedRecord => r.kind === "lock" || r.kind === "retire");
  } catch {
    return [];
  }
}

export function mirrorCheckContent(root: string, checkHash: string, home: string = homeDir()): string | null {
  const path = join(mirrorDir(root, home), "checks", `${checkHash}.spec.ts`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
