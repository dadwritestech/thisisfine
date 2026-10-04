export const NAME = "thisisfine";
export const STATE_DIR = ".thisisfine";
export const HOME_ENV = "THISISFINE_HOME";
export const PLAYWRIGHT_VERSION = "1.61.0";

/**
 * Runtime list and compile-time type come from one array:
 * `ledger.ts` validates `kind` against this list, so the two can never drift
 * and a hand-written `"kind":"approved"` line is rejected, not ignored.
 */
export const RECORD_KINDS = ["proposal", "lock", "dismiss", "retire"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const PROOF_METHODS = ["base", "sabotage", "none"] as const;
export type ProofMethod = (typeof PROOF_METHODS)[number];

/**
 * Evidence that a check can fail. `now` must have passed for a proposal to
 * exist at all. `without` is the run against a version of the app that lacks
 * the behaviour: a base commit, or the working tree with a sabotage patch.
 * `proven` is true only when that version booted *and* the check failed:
 * an app that won't start fails every check, which proves nothing.
 */
export interface Proof {
  proven: boolean;
  reason: string;
  now: { screenshot: string | null };
  without: {
    method: ProofMethod;
    ref: string | null;
    note: string | null;
    booted: boolean;
    failed: boolean;
    message: string;
    screenshot: string | null;
  };
}

export interface ProposalRecord {
  kind: "proposal";
  id: string;
  action: "lock" | "retire";
  number: number;
  sentence: string;
  /** Root-relative, forward slashes. */
  check: string;
  checkHash: string;
  proof: Proof | null;
  /** Why a retire was asked for; empty for locks. */
  reason: string;
  proposedAt: string;
}

/**
 * What a human "y" adds to a record. Written by the UserPromptSubmit hook,
 * never by the agent, and covered by the HMAC in `sig`.
 */
export interface Confirmation {
  words: string;
  promptId: string;
  sessionId: string;
  transcriptPath: string;
  keyId: string;
  sig: string;
}

export interface LockRecord extends Confirmation {
  kind: "lock";
  proposal: string;
  number: number;
  sentence: string;
  check: string;
  checkHash: string;
  proof: Proof | null;
  confirmedAt: string;
}

export interface RetireRecord extends Confirmation {
  kind: "retire";
  proposal: string;
  number: number;
  reason: string;
  retiredAt: string;
}

export interface DismissRecord {
  kind: "dismiss";
  proposal: string;
  words: string;
  at: string;
}

export type LedgerRecord = ProposalRecord | LockRecord | RetireRecord | DismissRecord;
export type SignedRecord = LockRecord | RetireRecord;

export interface Config {
  /** Shell command; `{port}` is substituted and PORT is also set. */
  start: string;
  readyPath: string;
  readyTimeoutMs: number;
  checkTimeoutMs: number;
  /** Untracked files (e.g. `.env`) copied into proof worktrees. */
  copy: string[];
}

/** Local, uncommitted bookkeeping. Losing it only costs speed and nudges. */
export interface State {
  lastGreenTree: string | null;
  promptsSinceNudge: number;
  lastBlockKey: string | null;
  consecutiveBlocks: number;
}
