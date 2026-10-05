import type { LedgerRecord, LockRecord, Proof, ProposalRecord, RetireRecord } from "./types.ts";

export interface PromiseState {
  number: number;
  sentence: string;
  check: string;
  checkHash: string;
  proof: Proof | null;
  lock: LockRecord;
  status: "active" | "retired";
  retire?: RetireRecord;
}

/**
 * Ledger order is the truth, last write wins. A
 * later lock of the same number is a deliberate replacement the human said
 * yes to; a retire only applies to a promise that is currently locked.
 */
export function foldPromises(records: LedgerRecord[]): Map<number, PromiseState> {
  const out = new Map<number, PromiseState>();
  for (const r of records) {
    if (r.kind === "lock") {
      out.set(r.number, {
        number: r.number, sentence: r.sentence, check: r.check, checkHash: r.checkHash,
        proof: r.proof, lock: r, status: "active"
      });
    } else if (r.kind === "retire") {
      const p = out.get(r.number);
      if (p && p.status === "active") out.set(r.number, { ...p, status: "retired", retire: r });
    }
  }
  return out;
}

export function activePromises(records: LedgerRecord[]): PromiseState[] {
  return [...foldPromises(records).values()].filter((p) => p.status === "active").sort((a, b) => a.number - b.number);
}

/**
 * Proposals still waiting for the human. If the agent re-proposes the same
 * number before the human answers (a better check, a sabotage retry), only
 * the newest one is put to them: a "y" should never lock a draft the agent
 * itself already replaced.
 */
export function pendingProposals(records: LedgerRecord[]): ProposalRecord[] {
  const answered = new Set<string>();
  for (const r of records) if (r.kind !== "proposal") answered.add(r.proposal);
  // the newest proposal per number wins, answered or not: an answered one
  // must not let the older proposal it superseded come back
  const latest = new Map<string, ProposalRecord>();
  for (const r of records) {
    if (r.kind === "proposal") latest.set(`${r.action}:${r.number}`, r);
  }
  return [...latest.values()].filter((p) => !answered.has(p.id)).sort((a, b) => a.number - b.number);
}

export function nextNumber(records: LedgerRecord[]): number {
  let max = 0;
  for (const r of records) {
    if ((r.kind === "proposal" && r.action === "lock") || r.kind === "lock") max = Math.max(max, r.number);
  }
  return max + 1;
}
