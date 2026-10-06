import { integrityProblems } from "./integrity.ts";
import { activePromises } from "./promises.ts";
import {
  brokenForAgent, brokenForHuman, fineMessage, integrityForAgent, integrityForHuman,
  loopBreakMessage, pendingMessage, stuckMessage, uncheckableForAgent, uncheckableForHuman
} from "./render.ts";
import type { Broken } from "./render.ts";
import { selectChecks } from "./select.ts";
import type { Keyring } from "./sign.ts";
import type { CheckOutcome, Coverage, LedgerRecord, SignedRecord, State } from "./types.ts";

/** Blocks in a row, for the same reason, before the human gets the wheel back. */
export const MAX_BLOCKS = 3;

export interface StopInput {
  records: LedgerRecord[];
  /** Set when the ledger exists but can't be parsed; `records` is then empty. */
  readError: string | null;
  mirror: SignedRecord[];
  keyring: Keyring;
  hashOf: (check: string) => string;
  /** Git tree of the working copy, or null outside git (then every stop runs). */
  treeId: string | null;
  state: State;
  /**
   * Boots the app and runs these checks once; throws if it can't. With
   * `record`, also maps which files each check loaded (null if it couldn't).
   */
  runAll: (checks: string[], record: boolean) => Promise<RunResult>;
  /** Paths that differ between that tree and the working tree; null if git can't say. */
  changedSince: (tree: string) => string[] | null;
  now: number;
  /** Run every promise whatever changed (`thisisfine check`). */
  forceAll?: boolean;
  /** How the human-facing messages name the agent. */
  who?: string;
}

export interface RunResult {
  outcomes: CheckOutcome[];
  coverage: Coverage | null;
}

export interface StopDecision {
  block: boolean;
  /** For the agent (Stop hook `reason`); empty when not blocking. */
  reason: string;
  /** For the human. */
  systemMessage: string;
  state: State;
}

function join(...parts: string[]): string {
  return parts.filter(Boolean).join("\n");
}

/**
 * The Stop hook's whole decision, minus I/O. Order matters:
 *  1. A ledger that disagrees with what the human signed blocks before any
 *     check runs, because a check that passes after being edited proves nothing.
 *  2. An unchanged tree that was green last time is green now: skip the browser.
 *  3. Run the promises the change can affect (all of them at the slightest
 *     doubt, see select.ts) once; failed or missing blocks, flaky warns.
 *
 * Only a full green run moves `lastGreenTree` and remakes the map. A
 * partial one moves `lastSelectedTree` and counts toward the next forced
 * full run, so it can never be mistaken for one.
 *
 * Every block is counted. The same block MAX_BLOCKS times in a row lets the
 * agent stop and tells the human instead: an agent that can't fix something
 * in three tries needs a person, not a fourth lap.
 */
export async function decideStop(i: StopInput): Promise<StopDecision> {
  const who = i.who ?? "Claude";
  const pending = pendingMessage(i.records);
  const allow = (systemMessage: string, state: State): StopDecision => ({ block: false, reason: "", systemMessage, state });

  const block = (key: string, reason: string, human: string, release: string): StopDecision => {
    const count = i.state.lastBlockKey === key ? i.state.consecutiveBlocks + 1 : 1;
    if (count > MAX_BLOCKS) {
      return allow(join(release, pending), { ...i.state, lastGreenTree: null, lastSelectedTree: null, lastBlockKey: null, consecutiveBlocks: 0 });
    }
    return { block: true, reason, systemMessage: human, state: { ...i.state, lastGreenTree: null, lastSelectedTree: null, lastBlockKey: key, consecutiveBlocks: count } };
  };

  if (i.readError) {
    const problems = [`.thisisfine/promises.jsonl can't be read (${i.readError})`];
    return block("unreadable", integrityForAgent(problems), integrityForHuman(problems), stuckMessage("the ledger can't be read", MAX_BLOCKS, who));
  }

  const problems = integrityProblems(i);
  if (problems.length) {
    return block(`integrity:${problems.join("|")}`, integrityForAgent(problems), integrityForHuman(problems),
      stuckMessage("promise records don't match what you confirmed", MAX_BLOCKS, who));
  }

  const active = activePromises(i.records);
  const settled = { ...i.state, lastBlockKey: null, consecutiveBlocks: 0 };
  if (active.length === 0) return allow(pending, settled);
  if (i.treeId !== null && i.treeId === i.state.lastGreenTree) return allow(pending, settled);

  const checks = active.map((p) => p.check);
  const selection = i.forceAll
    ? { all: true as const, why: "asked for" }
    : selectChecks({ active: checks, coverage: i.state.coverage, tree: i.treeId, changedSince: i.changedSince, now: i.now });
  if (!selection.all && i.treeId === i.state.lastSelectedTree) return allow(pending, settled);
  const toRun = selection.all ? checks : selection.checks;
  const running = active.filter((p) => toRun.includes(p.check));

  let outcomes: CheckOutcome[];
  let coverage: Coverage | null;
  try {
    ({ outcomes, coverage } = await i.runAll(toRun, selection.all));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return block(`uncheckable:${message.split("\n")[0]}`, uncheckableForAgent(message), uncheckableForHuman(message, who),
      stuckMessage("the promises couldn't be checked", MAX_BLOCKS, who));
  }

  const byCheck = new Map(outcomes.map((o) => [o.check, o]));
  const broken: Broken[] = [];
  const flaky: number[] = [];
  for (const p of running) {
    const outcome = byCheck.get(p.check) ?? { check: p.check, status: "missing", message: "", screenshot: null };
    if (outcome.status === "failed" || outcome.status === "missing") broken.push({ promise: p, outcome });
    else if (outcome.status === "flaky") flaky.push(p.number);
  }

  if (broken.length) {
    const numbers = broken.map((b) => b.promise.number);
    return block(`broken:${numbers.join(",")}`, brokenForAgent(broken), brokenForHuman(broken, who), loopBreakMessage(numbers, MAX_BLOCKS, who));
  }
  if (!selection.all) {
    const cov = i.state.coverage!;
    return allow(join(fineMessage(running.length, flaky, { of: active.length, why: selection.why }), pending),
      { ...settled, lastSelectedTree: i.treeId, coverage: { ...cov, selectedRuns: cov.selectedRuns + 1 } });
  }
  return allow(join(fineMessage(active.length, flaky), pending),
    { ...settled, lastGreenTree: i.treeId, lastSelectedTree: null, coverage: i.treeId === null ? null : coverage });
}
