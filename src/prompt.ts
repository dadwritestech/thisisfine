import { randomUUID } from "node:crypto";
import { classifyPrompt } from "./affirm.ts";
import { foldPromises, nextNumber, pendingProposals } from "./promises.ts";
import { dismissedContext, lockedContext, lockedMessage, nudgeContext } from "./render.ts";
import { signRecord } from "./sign.ts";
import { agentName } from "./types.ts";
import type { Agent, DismissRecord, LedgerRecord, LockRecord, RetireRecord, State } from "./types.ts";

export const NUDGE_EVERY = 5;

export interface PromptInput {
  prompt: string;
  promptId: string;
  sessionId: string;
  transcriptPath: string;
  now: string;
  key: Buffer;
  keyId: string;
  /** Current hash of a check file (root-relative path). */
  hashOf: (check: string) => string;
  /** Which agent's hook saw the prompt; decides how `verify` re-reads `transcriptPath`. */
  agent?: Agent;
}

export interface PromptDecision {
  append: LedgerRecord[];
  additionalContext: string;
  systemMessage: string;
  state: State;
}

/**
 * UserPromptSubmit. This hook, not the agent, is what turns the human's
 * "y" into a signed record: the hook receives the prompt from Claude Code
 * before the model sees it, so the words in a lock are words a person typed.
 */
export function decidePrompt(records: LedgerRecord[], state: State, input: PromptInput): PromptDecision {
  const quiet: PromptDecision = { append: [], additionalContext: "", systemMessage: "", state };
  const kind = classifyPrompt(input.prompt);
  if (kind === "machine" || kind === "command") return quiet;

  const pending = pendingProposals(records);
  if (pending.length === 0) {
    const since = state.promptsSinceNudge + 1;
    if (kind === "approval" && since >= NUDGE_EVERY) {
      return { ...quiet, additionalContext: nudgeContext(nextNumber(records)), state: { ...state, promptsSinceNudge: 0 } };
    }
    return { ...quiet, state: { ...state, promptsSinceNudge: since } };
  }

  const dismiss = (proposal: string): DismissRecord => ({ kind: "dismiss", proposal, words: input.prompt, at: input.now });

  if (kind !== "affirmative") {
    return {
      append: pending.map((p) => dismiss(p.id)),
      additionalContext: dismissedContext(pending.map((p) => p.number)),
      systemMessage: `Not locked: ${pending.map((p) => `#${p.number}`).join(", ")} (you didn't reply y).`,
      state
    };
  }

  const promises = foldPromises(records);
  const confirmation = {
    words: input.prompt, promptId: input.promptId, sessionId: input.sessionId,
    transcriptPath: input.transcriptPath, keyId: input.keyId, sig: "",
    // only pi's records carry it, so Claude Code records sign exactly as before
    ...(input.agent && input.agent !== "claude" ? { agent: input.agent } : {})
  };
  const append: LedgerRecord[] = [];
  const locked: { number: number; sentence: string; proven: boolean }[] = [];
  const retired: number[] = [];
  const refused: string[] = [];

  for (const p of pending) {
    if (p.action === "retire") {
      if (promises.get(p.number)?.status !== "active") {
        append.push(dismiss(p.id));
        refused.push(`#${p.number} is not an active promise`);
        continue;
      }
      const rec: RetireRecord = { kind: "retire", proposal: p.id, number: p.number, reason: p.reason, retiredAt: input.now, ...confirmation };
      append.push(signRecord(rec, input.key));
      retired.push(p.number);
      continue;
    }
    // The human said yes to the check as it was when proposed. If the file
    // changed since, they'd be signing something they never saw run.
    if (input.hashOf(p.check) !== p.checkHash) {
      append.push(dismiss(p.id));
      refused.push(`#${p.number}'s check changed after it was proposed; ask ${agentName(input.agent)} to propose it again`);
      continue;
    }
    const rec: LockRecord = {
      kind: "lock", proposal: p.id, number: p.number, sentence: p.sentence, check: p.check,
      checkHash: p.checkHash, proof: p.proof, confirmedAt: input.now, ...confirmation
    };
    append.push(signRecord(rec, input.key));
    locked.push({ number: p.number, sentence: p.sentence, proven: p.proof?.proven ?? false });
  }

  const messages = [lockedMessage(locked, retired), ...refused.map((r) => `Not locked: ${r}.`)].filter(Boolean);
  const context = locked.length || retired.length ? lockedContext(locked.map((l) => l.number), retired) : dismissedContext(pending.map((p) => p.number));
  return { append, additionalContext: context, systemMessage: messages.join(" "), state };
}

export function newProposalId(): string {
  return randomUUID();
}
