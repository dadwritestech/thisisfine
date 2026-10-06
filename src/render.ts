import { activePromises, foldPromises, pendingProposals } from "./promises.ts";
import type { PromiseState } from "./promises.ts";
import type { BehaviourDiff } from "./diff.ts";
import type { CheckOutcome, LedgerRecord, Proof, ProposalRecord } from "./types.ts";

/**
 * Every string a human or the agent reads comes from here, so the voice
 * stays one voice and the tests can pin it.
 */

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function proofLine(proof: Proof | null): string {
  if (!proof) return "🟡 unproven (never seen failing)";
  if (!proof.proven) return `✔ passes now 🟡 unproven: ${proof.reason}`;
  const w = proof.without;
  const where = w.method === "sabotage" ? `when sabotaged (${w.note ?? "patch"})` : `on ${w.ref}`;
  return `✔ passes now ✔ fails ${where} (app still boots)`;
}

/**
 * The app runs in the user's own folder, so a check that clicks "Save"
 * saves for real. Said once, at propose time, while the human can still
 * say no.
 */
export function sideEffectWarning(files: string[]): string {
  if (files.length === 0) return "";
  return [
    `⚠ While the check ran, the app wrote to: ${files.join(", ")}`,
    `  The gate re-runs this check before every Stop, so it will write there every time. If that is real data,`,
    `  ask the human to change "start" in .thisisfine/config.json so the app uses a scratch copy, then propose again.`
  ].join("\n");
}

/** `sentence` is only needed for retire proposals, which don't carry it. */
export function proposalLine(p: ProposalRecord, sentence: string): string {
  if (p.action === "retire") return `Retire promise #${p.number} "${sentence}"? Reason: ${p.reason}`;
  return `Lock in promise #${p.number} "${p.sentence}"? ${proofLine(p.proof)}`;
}

export function pendingMessage(records: LedgerRecord[]): string {
  const pending = pendingProposals(records);
  if (pending.length === 0) return "";
  const sentences = foldPromises(records);
  const lines = pending.map((p) => proposalLine(p, sentences.get(p.number)?.sentence ?? ""));
  const ask = pending.length === 1 ? "Reply y to confirm, anything else to skip." : "Reply y to confirm all of these, anything else to skip.";
  return `${lines.join("\n")}\n${ask}`;
}

export interface Broken {
  promise: PromiseState;
  outcome: CheckOutcome;
}

function quoteHuman(p: PromiseState): string {
  return `on ${shortDate(p.lock.confirmedAt)}: "${p.lock.words.trim()}"`;
}

function indent(text: string, by = "   "): string {
  return text.trim().split("\n").slice(0, 20).map((l) => by + l).join("\n");
}

/** Stop-hook `reason`: read by the agent, which must keep working. */
/** A page stuck in an error loop must not bury the assertion. */
function capped(errors: string[], max = 5): string {
  const more = errors.length - max;
  return [...errors.slice(0, max), ...(more > 0 ? [`(and ${more} more)`] : [])].join("\n");
}

export function brokenForAgent(broken: Broken[]): string {
  const parts = broken.map(({ promise: p, outcome: o }) => {
    const lines = [`🔥 This is NOT fine. You broke promise #${p.number} "${p.sentence}".`,
      `   The human confirmed it ${quoteHuman(p)}`, `   Check: ${p.check}`];
    // before the failure: Playwright's call log can fill the whole indent cap
    if (o.pageErrors?.length) lines.push("   The page threw while loading:", indent(capped(o.pageErrors), "     "));
    if (o.checkErrors?.length) lines.push("   The page threw during the check:", indent(capped(o.checkErrors), "     "));
    if (o.status === "missing") lines.push("   The check produced no result (deleted, renamed, or it no longer compiles).");
    else if (o.message) lines.push("   Failure:", indent(o.message, "     "));
    if (o.screenshot) lines.push(`   Screenshot: ${o.screenshot}`);
    return lines.join("\n");
  });
  const numbers = broken.map((b) => `#${b.promise.number}`).join(", ");
  return [...parts, "",
    `Fix the app so ${numbers} hold${broken.length === 1 ? "s" : ""} again. Do not edit the checks, the ledger, or the config.`,
    `If the human's latest request really does require changing this behaviour, stop and ask them to retire it (thisisfine retire <n> --reason "...").`
  ].join("\n");
}

/** Stop-hook `systemMessage`: read by the human. */
export function brokenForHuman(broken: Broken[], who = "Claude"): string {
  const list = broken.map(({ promise: p }) => `#${p.number} "${p.sentence}" (you locked it ${quoteHuman(p)})`).join("; ");
  return `🔥 This is NOT fine. ${who} broke ${list}. Sent it back to fix.`;
}

/** `partial`: only the promises the change can affect ran, out of `of` active. */
export function fineMessage(kept: number, flaky: number[], partial?: { of: number; why: string }): string {
  const base = partial
    ? `☕ This is fine. ${kept}/${kept} promise${kept === 1 ? "" : "s"} this change can affect kept (${partial.of - kept} others skipped: ${partial.why})`
    : `☕ This is fine. ${kept}/${kept} promises kept`;
  if (flaky.length === 0) return `${base}.`;
  const which = flaky.map((n) => `#${n}`).join(", ");
  return `${base} (${which} ${flaky.length === 1 ? "was" : "were"} flaky: passed on retry).`;
}

export function integrityForAgent(problems: string[]): string {
  return [
    "🔥 This is NOT fine. The promise ledger no longer matches what the human confirmed:",
    ...problems.map((p) => `   - ${p}`),
    "",
    "Run \"thisisfine restore\" to put back exactly what the human confirmed (it rewrites the records and locked checks from its own copy). Don't edit them by hand.",
    "Only the human can change a promise: propose a replacement (thisisfine propose --replaces <n>) or a retirement, and let them answer."
  ].join("\n");
}

/** When the app can't even be checked: the agent has to fix that first. */
export function uncheckableForAgent(error: string): string {
  return [
    "🔥 This is NOT fine. thisisfine couldn't check the promises, so it can't let you stop:",
    indent(error, "   "),
    "",
    "Get the app starting again (the start command lives in .thisisfine/config.json; ask the human before changing it)."
  ].join("\n");
}

export function uncheckableForHuman(error: string, who = "Claude"): string {
  return `🔥 This is NOT fine. Couldn't check the promises: ${error.trim().split("\n")[0]}. Sent ${who} back to fix it.`;
}

/** Same block, different cause than a broken promise (integrity, app won't start). */
export function stuckMessage(what: string, tries: number, who = "Claude"): string {
  return `🔥 thisisfine blocked ${tries} stops in a row (${what}), so I let ${who} stop. Your call: run "thisisfine verify" to see what's wrong.`;
}

export function integrityForHuman(problems: string[]): string {
  return `🔥 This is NOT fine. Promise records were changed without your "y": ${problems.join("; ")}`;
}

export function loopBreakMessage(broken: number[], tries: number, who = "Claude"): string {
  const which = broken.map((n) => `#${n}`).join(", ");
  return `🔥 ${who} couldn't keep promise ${which} after ${tries} tries, so I let it stop. Your call: tell it how to fix it, or /retire the promise if the behaviour should change.`;
}

export function lockedMessage(locked: { number: number; sentence: string; proven: boolean }[], retired: number[]): string {
  const parts = locked.map((l) => `🔒 Locked promise #${l.number} "${l.sentence}"${l.proven ? "" : " (🟡 unproven)"}.`);
  for (const n of retired) parts.push(`🗑️ Retired promise #${n}.`);
  return parts.join(" ");
}

export function lockedContext(locked: number[], retired: number[]): string {
  const parts: string[] = [];
  if (locked.length) parts.push(`The human confirmed: promise ${locked.map((n) => `#${n}`).join(", ")} is now locked. Its check runs before every stop.`);
  if (retired.length) parts.push(`The human confirmed: promise ${retired.map((n) => `#${n}`).join(", ")} is retired and no longer enforced.`);
  return `[thisisfine] ${parts.join(" ")} Continue with anything else they asked in this message.`;
}

export function dismissedContext(numbers: number[]): string {
  return `[thisisfine] The human did not say yes to proposal ${numbers.map((n) => `#${n}`).join(", ")}, so nothing was locked. Treat their message as feedback; re-propose later only if they ask.`;
}

export function nudgeContext(next: number): string {
  return `[thisisfine] The human just approved something. If a specific, user-visible behaviour was just confirmed, offer to lock it in as promise #${next}: write one Playwright check for it in .thisisfine/checks/ and run "thisisfine propose". One sentence, one behaviour. If it isn't clear what was confirmed, don't.`;
}

export function sessionContext(cli: string, records: LedgerRecord[]): string {
  const active = activePromises(records);
  const list = active.length
    ? active.map((p) => `  #${p.number} ${p.sentence}${p.proof?.proven ? "" : " (unproven)"}`).join("\n")
    : "  (none yet)";
  return [
    `[thisisfine] This project has promises: behaviours the human confirmed, each locked to a Playwright check that runs in a real browser before you can finish a turn.`,
    `Active promises:`,
    list,
    `CLI: ${cli} <command>   (status | propose | check | retire)`,
    `Rules: never edit .thisisfine/promises.jsonl, .thisisfine/config.json, or a locked check. To change locked behaviour, ask the human to retire the promise first.`,
    `When the human confirms a behaviour ("works", "perfect"), offer to lock it: see the writing-promises skill, then run propose and relay its question verbatim.`
  ].join("\n");
}

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(1, n - [...s].length));
}

export function statusText(records: LedgerRecord[]): string {
  const all = [...foldPromises(records).values()].sort((a, b) => a.number - b.number);
  const pending = pendingProposals(records);
  const active = all.filter((p) => p.status === "active");
  const proven = active.filter((p) => p.proof?.proven).length;
  const head = `thisisfine: ${active.length} active promise${active.length === 1 ? "" : "s"} (${proven} proven, ${active.length - proven} 🟡 unproven), ${pending.length} pending`;
  const rows = all.map((p) => {
    const label = p.status === "retired" ? "retired" : p.proof?.proven ? "✅ proven" : "🟡 unproven";
    const when = p.status === "retired" && p.retire ? `retired ${shortDate(p.retire.retiredAt)}` : `locked ${shortDate(p.lock.confirmedAt)} ("${p.lock.words.trim()}")`;
    // two lines, so a long sentence never pushes the date out of line
    return `  ${pad(`#${p.number}`, 5)}${pad(label, 13)}"${p.sentence}"\n  ${" ".repeat(18)}${when}`;
  });
  const pend = pending.map((p) => `  pending #${p.number} "${p.action === "retire" ? `retire: ${p.reason}` : p.sentence}" (reply y to confirm)`);
  return [head, "", ...rows, ...pend].join("\n");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const numbers = (ps: { number: number }[]) => ps.map((p) => `#${p.number}`).join(", ");

function describeRecord(r: LedgerRecord): string {
  return r.kind === "dismiss" ? "a dismissal" : `#${r.number} ${r.kind === "retire" ? "retirement" : r.kind}`;
}

/**
 * `thisisfine diff`: what a branch does to the promises, for a PR. Problems
 * first, then the changes a reviewer should read, then what still holds.
 * In markdown the lines sit in a ```diff fence, so GitHub paints + green and
 * - red; the signature note stays outside it as prose.
 */
export function diffText(d: BehaviourDiff, opts: { base: string; markdown: boolean }): string {
  const lines: string[] = [];
  if (d.notRun !== null) lines.push(`✗ The checks didn't run: ${d.notRun.trim().split("\n")[0]}`);
  for (const { promise: p, outcome: o } of d.broken) {
    lines.push(`✗ #${p.number} broken: "${p.sentence}"`);
    if (o.status === "missing") lines.push("    The check produced no result (deleted, renamed, or it no longer compiles).");
    else if (o.message) lines.push(indent(o.message, "    "));
  }
  for (const p of d.edited) lines.push(`✗ #${p.number}'s check was changed after it was locked (${p.check})`);
  if (d.dropped.length) {
    lines.push(`✗ ${plural(d.dropped.length, "record")} from ${opts.base} is missing here (${d.dropped.map(describeRecord).join(", ")}).`,
      "    promises.jsonl is append-only: a confirmation was deleted or rewritten.");
  }
  for (const r of d.badSignatures) lines.push(`✗ #${r.number}'s ${r.kind === "lock" ? "lock" : "retirement"}: the signature doesn't match, so it was edited after the human confirmed it`);

  for (const p of d.locked) {
    const label = p.proof?.proven ? "✅ proven" : "🟡 unproven";
    lines.push(`+ #${p.number} locked: "${p.sentence}" ${label} ("${p.lock.words.trim()}", ${shortDate(p.lock.confirmedAt)})`);
  }
  for (const { before, after } of d.replaced) lines.push(`~ #${after.number} replaced: "${before.sentence}" → "${after.sentence}"`);
  for (const p of d.retired) lines.push(`- #${p.number} retired: "${p.sentence}" (${p.retire?.reason.trim() || "no reason given"})`);
  for (const { proposal: p, sentence } of d.pending) {
    lines.push(p.action === "retire"
      ? `? #${p.number} retirement waiting for a human y: "${sentence}" (${p.reason})`
      : `? #${p.number} waiting for a human y: "${sentence}"`);
  }
  if (d.locked.length + d.replaced.length + d.retired.length + d.pending.length === 0) lines.push("No promises changed on this branch.");

  for (const p of d.flaky) lines.push(`! #${p.number} flaky: passed on retry`);
  if (d.kept.length) lines.push(`✔ ${plural(d.kept.length, "promise")} kept (${numbers(d.kept)})`);

  let note = "";
  if (d.unverifiable.length) {
    const keys = [...new Set(d.unverifiable.map((r) => r.keyId))].join(", ");
    const n = d.unverifiable.length;
    note = `ℹ Signatures not verified: ${plural(n, "new confirmation")} ${n === 1 ? "was" : "were"} signed with a key that isn't in .thisisfine/keys/ (key ${keys}). `
      + `Commit the public key from the machine where the human said yes (thisisfine writes it there on the first lock), or run "thisisfine verify" on that machine.`;
  }

  const title = `thisisfine: what this branch does to the promises (vs ${opts.base})`;
  if (!opts.markdown) return [title, ...lines, ...(note ? ["", note] : [])].join("\n");
  return [`### ${title}`, "", "```diff", ...lines, "```", ...(note ? ["", note] : [])].join("\n");
}

const ASK_TO_RETIRE =`To change it, ask the human to retire the promise (thisisfine retire <n> --reason "...") and let them answer.`;

export const guardText = {
  ledger: `thisisfine: .thisisfine/promises.jsonl is written only by thisisfine, after the human says yes. Use "thisisfine status" to read it.`,
  hooks: `thisisfine: hook commands run only from the agent's own hooks (Claude Code's or pi's), because only the human can answer a proposal.`,
  home: `thisisfine: the signing key and the confirmed copies of every promise live there. They are not for the agent to read or change.`,
  keys: `thisisfine: .thisisfine/keys/ holds the public keys that vouch for locked promises. Only thisisfine writes this machine's key there; a teammate's key is added by a person, in a reviewed commit.`,
  check: (number: number, sentence: string) =>
    `thisisfine: this check is promise #${number} "${sentence}", which the human locked. Fix the app, not the check. ${ASK_TO_RETIRE}`,
  config: (rel: string) =>
    `thisisfine: ${rel} decides how locked promises are checked, so it is frozen once a promise is locked. If it really needs to change, ask the human to edit it.`,
  stateDir: `thisisfine: this command would write inside .thisisfine/ where locked promises live. Write new checks with the Write tool instead; to change a locked promise, ask the human to retire it.`,
  nested: `thisisfine: that variable is how thisisfine tells a person's "y" from one typed by an agent you started. Leave it alone; only the human can answer a proposal.`
};

/** A prompt submitted by an agent that another agent's shell started: it can't lock, and it doesn't dismiss either. */
export function nestedContext(marker: string): string {
  return `[thisisfine] This session was started from inside another agent session (${marker} is set), so a "y" here can't lock or retire a promise. Only the human, in their own session, can answer a proposal.`;
}
