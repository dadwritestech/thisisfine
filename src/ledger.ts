import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LedgerRecord, RecordKind } from "./types.ts";
import { RECORD_KINDS, STATE_DIR } from "./types.ts";

export function ledgerPath(root: string): string {
  return join(root, STATE_DIR, "promises.jsonl");
}

/** Append-only: nothing in thisisfine ever rewrites or deletes a line. */
export function appendRecord(path: string, record: LedgerRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

/**
 * Field validator with a description for the error, so a corrupt line names
 * its own problem.
 */
interface FieldSpec {
  check(value: unknown): boolean;
  describe: string;
}

const STRING: FieldSpec = { check: (v) => typeof v === "string", describe: "a string" };
const NONEMPTY: FieldSpec = { check: (v) => typeof v === "string" && v.trim() !== "", describe: "a non-empty string" };
const NUMBER: FieldSpec = { check: (v) => Number.isInteger(v) && (v as number) > 0, describe: "a positive integer" };
const PROOF: FieldSpec = { check: (v) => v === null || (typeof v === "object" && !Array.isArray(v)), describe: "an object or null" };
const ACTION: FieldSpec = { check: (v) => v === "lock" || v === "retire", describe: "lock or retire" };

/**
 * A check path must stay inside the project: relative, forward slashes, no
 * `..` segment. Otherwise a ledger line could point the runner (and the
 * guard's notion of "locked file") anywhere on disk.
 */
export function isContainedPath(v: unknown): boolean {
  if (typeof v !== "string" || v === "") return false;
  if (v.startsWith("/") || v.includes("\\") || /^[A-Za-z]:/.test(v)) return false;
  return !v.split("/").includes("..");
}
const CONTAINED: FieldSpec = { check: isContainedPath, describe: "a project-relative path with forward slashes" };

const CONFIRMATION: Record<string, FieldSpec> = {
  words: STRING, promptId: STRING, sessionId: STRING, transcriptPath: STRING, keyId: NONEMPTY, sig: NONEMPTY
};

const SHAPES: Record<RecordKind, Record<string, FieldSpec>> = {
  proposal: {
    id: NONEMPTY, action: ACTION, number: NUMBER, sentence: NONEMPTY, check: CONTAINED,
    checkHash: NONEMPTY, proof: PROOF, reason: STRING, proposedAt: NONEMPTY
  },
  lock: {
    proposal: NONEMPTY, number: NUMBER, sentence: NONEMPTY, check: CONTAINED, checkHash: NONEMPTY,
    proof: PROOF, confirmedAt: NONEMPTY, ...CONFIRMATION
  },
  retire: { proposal: NONEMPTY, number: NUMBER, reason: STRING, retiredAt: NONEMPTY, ...CONFIRMATION },
  dismiss: { proposal: NONEMPTY, words: STRING, at: NONEMPTY }
};

export function validateRecord(value: unknown, where: string): LedgerRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where}: expected an object`);
  }
  const rec = value as Record<string, unknown>;
  if (!RECORD_KINDS.includes(rec.kind as RecordKind)) {
    throw new Error(`${where}: kind must be one of ${RECORD_KINDS.join(", ")}`);
  }
  for (const [field, spec] of Object.entries(SHAPES[rec.kind as RecordKind])) {
    if (!spec.check(rec[field])) throw new Error(`${where}: ${rec.kind}.${field} must be ${spec.describe}`);
  }
  return rec as unknown as LedgerRecord;
}

/**
 * Reads and validates every line. Throws on the first bad line: the gate
 * treats an unreadable ledger as a block, never as "no promises".
 */
export function readLedger(path: string): LedgerRecord[] {
  if (!existsSync(path)) return [];
  const out: LedgerRecord[] = [];
  readFileSync(path, "utf8").split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    const where = `${path} line ${i + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`${where}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    out.push(validateRecord(parsed, where));
  });
  return out;
}
