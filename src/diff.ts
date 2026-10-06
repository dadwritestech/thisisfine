import { foldPromises, pendingProposals } from "./promises.ts";
import type { PromiseState } from "./promises.ts";
import type { Broken } from "./render.ts";
import { verifyRecord } from "./sign.ts";
import type { CheckOutcome, LedgerRecord, ProposalRecord, SignedRecord } from "./types.ts";

/** What `thisisfine check --report` writes: the gate's outcomes, for `diff` to read. */
export interface CheckReport {
  /** False when the checks never ran (integrity problem, app didn't start). */
  ran: boolean;
  reason: string;
  outcomes: CheckOutcome[];
}

export interface DiffInput {
  base: LedgerRecord[];
  head: LedgerRecord[];
  /** Hash of a check file as it is in head. */
  hashOf: (check: string) => string;
  key: Buffer;
  keyId: string;
  report: CheckReport | null;
}

export interface BehaviourDiff {
  locked: PromiseState[];
  replaced: { before: PromiseState; after: PromiseState }[];
  retired: PromiseState[];
  pending: { proposal: ProposalRecord; sentence: string }[];
  /** Base records head no longer has: the append-only ledger was rewritten. */
  dropped: LedgerRecord[];
  /** Active promises whose check file no longer hashes to what was signed. */
  edited: PromiseState[];
  broken: Broken[];
  flaky: PromiseState[];
  kept: PromiseState[];
  notRun: string | null;
  /** Locks and retirements head added. */
  newSigned: SignedRecord[];
  /** Of those, signed with a key this machine doesn't have. */
  unverifiable: SignedRecord[];
  badSignatures: SignedRecord[];
  ok: boolean;
}

const isSigned = (r: LedgerRecord): r is SignedRecord => r.kind === "lock" || r.kind === "retire";
const byNumber = (a: { number: number }, b: { number: number }) => a.number - b.number;

/**
 * What a branch did to the promises: base and head ledgers folded with the
 * same rules as the gate, then compared. A ledger line is identified by its
 * exact JSON, so "every base line is still in head" is the append-only rule.
 */
export function behaviourDiff(i: DiffInput): BehaviourDiff {
  const before = foldPromises(i.base);
  const after = foldPromises(i.head);
  const active = [...after.values()].filter((p) => p.status === "active").sort(byNumber);

  const locked: PromiseState[] = [];
  const replaced: BehaviourDiff["replaced"] = [];
  const retired: PromiseState[] = [];
  for (const p of [...after.values()].sort(byNumber)) {
    const was = before.get(p.number);
    if (p.status === "retired") {
      if (was?.status === "active") retired.push(p);
    } else if (!was || was.status === "retired") {
      locked.push(p);
    } else if (was.lock.proposal !== p.lock.proposal) {
      replaced.push({ before: was, after: p });
    }
  }

  const baseIds = new Set(i.base.filter((r) => r.kind === "proposal").map((r) => (r as ProposalRecord).id));
  const pending = pendingProposals(i.head)
    .filter((p) => !baseIds.has(p.id))
    .map((p) => ({ proposal: p, sentence: p.action === "retire" ? after.get(p.number)?.sentence ?? p.sentence : p.sentence }));

  const headLines = new Set(i.head.map((r) => JSON.stringify(r)));
  const dropped = i.base.filter((r) => !headLines.has(JSON.stringify(r)));

  const edited = active.filter((p) => i.hashOf(p.check) !== p.checkHash);

  const broken: Broken[] = [];
  const flaky: PromiseState[] = [];
  const kept: PromiseState[] = [];
  let notRun: string | null = null;
  if (i.report && !i.report.ran) {
    notRun = i.report.reason;
  } else if (i.report) {
    const outcomes = new Map(i.report.outcomes.map((o) => [o.check, o]));
    for (const p of active) {
      const outcome = outcomes.get(p.check) ?? { check: p.check, status: "missing", message: "", screenshot: null };
      if (outcome.status === "failed" || outcome.status === "missing") broken.push({ promise: p, outcome });
      else if (outcome.status === "flaky") flaky.push(p);
      else kept.push(p);
    }
  }

  const baseSigs = new Set(i.base.filter(isSigned).map((r) => r.sig));
  const newSigned = i.head.filter(isSigned).filter((r) => !baseSigs.has(r.sig));
  const unverifiable = newSigned.filter((r) => r.keyId !== i.keyId);
  const badSignatures = newSigned.filter((r) => r.keyId === i.keyId && !verifyRecord(r, i.key));

  const ok = dropped.length === 0 && edited.length === 0 && broken.length === 0 && notRun === null && badSignatures.length === 0;
  return { locked, replaced, retired, pending, dropped, edited, broken, flaky, kept, notRun, newSigned, unverifiable, badSignatures, ok };
}
