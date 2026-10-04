import { activePromises } from "./promises.ts";
import { shortDate } from "./render.ts";
import { verifyRecord } from "./sign.ts";
import type { LedgerRecord, SignedRecord } from "./types.ts";
import { STATE_DIR } from "./types.ts";

export interface IntegrityInput {
  records: LedgerRecord[];
  mirror: SignedRecord[];
  key: Buffer;
  keyId: string;
  hashOf: (check: string) => string;
}

function isSigned(r: LedgerRecord): r is SignedRecord {
  return r.kind === "lock" || r.kind === "retire";
}

/**
 * Everything that makes the ledger disagree with what the human confirmed.
 * Records signed on another machine can't be verified here (v0 has no
 * shared keys), so they are trusted when they *add* promises and refused
 * when they weaken a promise this machine signed: a forged "retire" with a
 * made-up key id must not be an escape hatch.
 */
export function integrityProblems(i: IntegrityInput): string[] {
  const problems: string[] = [];
  const localOwned = new Set<number>();
  for (const r of i.records) {
    if (!isSigned(r)) continue;
    const what = r.kind === "lock" ? "lock" : "retirement";
    if (r.keyId === i.keyId) {
      if (!verifyRecord(r, i.key)) {
        problems.push(`#${r.number}: the ${what} record's signature doesn't match, so it was edited after you confirmed it`);
        continue;
      }
      if (r.kind === "lock") localOwned.add(r.number);
    } else if (localOwned.has(r.number)) {
      problems.push(`#${r.number} was ${r.kind === "retire" ? "retired" : "replaced"} by a record this machine didn't sign (key ${r.keyId})`);
    }
  }

  for (const p of activePromises(i.records)) {
    const h = i.hashOf(p.check);
    if (h === "missing") problems.push(`#${p.number}'s check was deleted (${p.check})`);
    else if (h !== p.checkHash) problems.push(`#${p.number}'s check was changed after you confirmed it (${p.check})`);
  }

  const present = new Set(i.records.filter(isSigned).map((r) => r.sig));
  for (const m of i.mirror) {
    if (present.has(m.sig)) continue;
    const when = m.kind === "lock" ? m.confirmedAt : m.retiredAt;
    problems.push(`#${m.number}'s ${m.kind === "lock" ? "lock" : "retirement"} (you said "${m.words.trim()}" on ${shortDate(when)}) is missing from ${STATE_DIR}/promises.jsonl`);
  }
  return problems;
}
