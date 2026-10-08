import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, detectConfig, writeScaffold } from "./config.ts";
import { behaviourDiff } from "./diff.ts";
import type { CheckReport } from "./diff.ts";
import { decideStop } from "./gate.ts";
import type { RunResult } from "./gate.ts";
import { changedPaths, changedSince, fileAtRef, footprint, repoRoot, treeBlobs, treeId } from "./git.ts";
import { decideGuard } from "./guard.ts";
import { fileHash } from "./hash.ts";
import { integrityProblems, keyLabel } from "./integrity.ts";
import { appendRecord, ledgerPath, parseLedger, readLedger } from "./ledger.ts";
import { startApp } from "./launcher.ts";
import { appendMirror, mirrorCheckContent, readMirror } from "./mirror.ts";
import { decidePrompt, newProposalId } from "./prompt.ts";
import { activePromises, foldPromises, nextNumber } from "./promises.ts";
import { prove } from "./prove.ts";
import { findRoot } from "./root.ts";
import { diffText, nestedContext, pendingMessage, proofLine, sessionContext, shortDate, sideEffectWarning, statusText } from "./render.ts";
import { restoredLedger } from "./restore.ts";
import { startRecorder } from "./recorder.ts";
import type { Recorder } from "./recorder.ts";
import { pageErrors, withoutLoadErrors } from "./runner.ts";
import { runChecks } from "./runners.ts";
import { buildCoverage, usesOwnHttp } from "./select.ts";
import { buildKeyring, KEYS_DIR, publishPublicKey, readPublicKeys } from "./keys.ts";
import { checkSignature, homeDir, loadOrCreateSigner, loadSigner } from "./sign.ts";
import type { Signer } from "./sign.ts";
import { loadState, saveState } from "./state.ts";
import { verifyWords } from "./transcript.ts";
import type { Agent, CheckOutcome, Coverage, LedgerRecord, ProposalRecord, SignedRecord } from "./types.ts";
import { agentName, NESTED_AGENT_ENVS, PLAYWRIGHT_VERSION, STATE_DIR } from "./types.ts";

const USAGE = `thisisfine: promises your coding agent can't quietly break.

Usage: thisisfine <command>

  init                         set up .thisisfine/ here and install Playwright ${PLAYWRIGHT_VERSION} into it
  propose --sentence "..." --check .thisisfine/checks/<file>.spec.ts
          [--base <git ref> | --sabotage <patch> --sabotage-note "..."] [--replaces <n>]
                               prove a check, then ask the human to lock it
  status                       list promises
  check [--report <file.json>] run every active promise now (--report: write the outcomes for diff)
  diff <base-ref> [--report <file.json>] [--markdown]
                               what this branch does to the promises: locked, retired, broken
  retire <n> --reason "..."    ask the human to retire a promise
  verify [--strict]            audit signatures, check files, and the human's words;
                               --strict (for CI) also fails on locks no committed key can check
  restore                      put back exactly what the human confirmed

Hooks (run by Claude Code or the pi extension, not by hand): hook-session, hook-prompt, hook-guard, hook-stop
`;

class UsageError extends Error {}

const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
const err = (s: string) => process.stderr.write(s.endsWith("\n") ? s : s + "\n");

/** How the agent should call us: the session context hands it this exact string. */
export function cliCommand(): string {
  const bin = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "thisisfine.mjs");
  return `node "${bin.replace(/\\/g, "/")}"`;
}

export { findRoot };

function requireRoot(): string {
  const root = findRoot(process.cwd());
  if (!root) throw new Error(`No ${STATE_DIR}/config.json here or above. Run "thisisfine init" in the project root first.`);
  return root;
}

function readRecords(root: string): { records: LedgerRecord[]; readError: string | null } {
  try {
    return { records: readLedger(ledgerPath(root)), readError: null };
  } catch (e) {
    return { records: [], readError: e instanceof Error ? e.message : String(e) };
  }
}

function records(root: string): LedgerRecord[] {
  const { records: r, readError } = readRecords(root);
  if (readError) throw new Error(`${STATE_DIR}/promises.jsonl can't be read: ${readError}. "thisisfine restore" rebuilds it from the confirmed copy.`);
  return r;
}

const hashOf = (root: string) => (check: string) => fileHash(join(root, check));

function stamp(label: string): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`;
}

/** Runs pile up screenshots; keep the latest few. */
function pruneRuns(root: string, keep = 10): void {
  const dir = join(root, STATE_DIR, "runs");
  if (!existsSync(dir)) return;
  const runs = readdirSync(dir).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - keep))) {
    rmSync(join(dir, old), { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Starts the recording proxies, or nothing if there is no git tree to map
 * against or they won't start: a run that can't record is still a run.
 */
async function tryRecorder(root: string, tree: string | null, checks: string[]): Promise<Recorder | null> {
  if (tree === null) return null;
  try {
    return await startRecorder(checks);
  } catch {
    return null;
  }
}

/** What each check loaded, as a map of repo files; null if anything about recording went wrong. */
async function mapOf(root: string, tree: string | null, checks: string[], rec: Recorder | null): Promise<Coverage | null> {
  if (!rec || tree === null) return null;
  try {
    const hits = await rec.stop();
    const ownHttp = checks.filter((c) => usesOwnHttp(readFileSync(join(root, c), "utf8")));
    return buildCoverage({ tree, madeAt: new Date().toISOString(), blobs: treeBlobs(root, tree), hits, ownHttp });
  } catch {
    return null;
  }
}

/**
 * Boot the app once and run these checks against it. With `record`, every
 * check's browser goes through its own recording proxy, which is how the
 * gate learns which files each promise touches.
 */
async function runAll(root: string, checks: string[], label: string, record: boolean, tree: string | null): Promise<RunResult> {
  const config = loadConfig(root);
  pruneRuns(root);
  const runDir = join(root, STATE_DIR, "runs", stamp(label));
  const rec = record ? await tryRecorder(root, tree, checks) : null;
  const app = await startApp({
    cwd: root, start: config.start, readyPath: config.readyPath, readyTimeoutMs: config.readyTimeoutMs,
    logPath: join(runDir, "app.log")
  });
  try {
    const outcomes = await runChecks({
      root, checks, baseUrl: app.url, runDir, retries: 1, timeoutMs: config.checkTimeoutMs, ...(rec ? { proxies: rec.ports } : {})
    });
    const coverage = await mapOf(root, tree, checks, rec);
    const failed = outcomes.filter((o) => o.status === "failed" || o.status === "missing");
    if (failed.length === 0) return { outcomes, coverage };
    const errors = await pageErrors(root, app.url);
    for (const o of failed) {
      o.pageErrors = errors;
      if (o.checkErrors) o.checkErrors = withoutLoadErrors(o.checkErrors, errors);
    }
    return { outcomes, coverage };
  } finally {
    await rec?.stop();
    await app.stop();
  }
}

function toCheckPath(root: string, raw: string): string {
  const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  const rel = relative(root, abs).replace(/\\/g, "/");
  if (!rel.startsWith(`${STATE_DIR}/checks/`) || !rel.endsWith(".spec.ts") || rel.includes("/../")) {
    throw new UsageError(`--check must be a .spec.ts file inside ${STATE_DIR}/checks/ (got ${raw})`);
  }
  if (!existsSync(abs)) throw new UsageError(`--check ${raw}: no such file`);
  return rel;
}

function positiveInt(raw: string | undefined, what: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${what} must be a promise number like 3 (got ${raw ?? "nothing"})`);
  return n;
}

// ── commands ────────────────────────────────────────────────────────────

function cmdInit(install: boolean): number {
  const root = repoRoot(process.cwd()) ?? resolve(process.cwd());
  const { config, detected, known } = detectConfig(root);
  const written = writeScaffold(root, config);
  const current = loadConfig(root);
  // a start command the human already edited counts as known, whatever the project looks like
  const guessing = !known && current.start === config.start;
  out(`thisisfine init in ${root}`);
  if (!guessing) {
    if (known) out(`  App: ${detected}`);
    out(`  Start command: ${current.start}   (edit ${STATE_DIR}/config.json if that's wrong)`);
  }
  if (written.length) out(`  Wrote: ${written.join(", ")}`);
  if (!repoRoot(root)) out(`  ⚠ Not a git repository. Proofs compare against an earlier commit, so run "git init" and commit first.`);
  if (install) {
    out(`  Installing @playwright/test ${PLAYWRIGHT_VERSION} into ${STATE_DIR}/ (nothing outside it is touched)...`);
    const dir = join(root, STATE_DIR);
    const npm = spawnSync("npm install --no-audit --no-fund --loglevel=error", { cwd: dir, shell: true, stdio: "inherit" });
    if (npm.status !== 0) throw new Error(`npm install failed in ${dir}`);
    const browsers = spawnSync(process.execPath, [join(dir, "node_modules", "@playwright", "test", "cli.js"), "install", "chromium"], { cwd: dir, stdio: "inherit" });
    if (browsers.status !== 0) throw new Error("Playwright couldn't install Chromium");
  }
  if (guessing) {
    out(`  Not ready yet: set "start" in ${STATE_DIR}/config.json to the command that runs your app on {port},`);
    out(`  e.g. "python app.py --port {port}". thisisfine fills in a free port and also sets PORT.`);
  } else {
    out(`  Ready. Commit ${STATE_DIR}/ so promises travel with the code.`);
  }
  return 0;
}

async function cmdPropose(v: Record<string, string | boolean | undefined>): Promise<number> {
  const root = requireRoot();
  const sentence = typeof v.sentence === "string" ? v.sentence.trim() : "";
  if (!sentence) throw new UsageError(`--sentence is required: one sentence, one behaviour the human can see`);
  if (typeof v.check !== "string") throw new UsageError(`--check is required`);
  if (v.base && v.sabotage) throw new UsageError(`use --base or --sabotage, not both`);
  const check = toCheckPath(root, v.check);
  const all = records(root);
  const active = activePromises(all);

  let number: number;
  if (v.replaces !== undefined) {
    number = positiveInt(String(v.replaces), "--replaces");
    if (!active.some((p) => p.number === number)) throw new UsageError(`--replaces ${number}: there is no active promise #${number}`);
  } else {
    number = nextNumber(all);
  }
  const owner = active.find((p) => p.check === check && p.number !== number);
  if (owner) throw new UsageError(`${check} is already promise #${owner.number}'s check. Write a new file for a new promise.`);

  const config = loadConfig(root);
  const before = fileHash(join(root, check));
  pruneRuns(root);
  const runDir = join(root, STATE_DIR, "runs", stamp(`propose-${number}`));
  const sabotage = typeof v.sabotage === "string"
    ? { patch: resolve(process.cwd(), v.sabotage), note: typeof v["sabotage-note"] === "string" ? v["sabotage-note"] : v.sabotage }
    : undefined;
  if (sabotage && !existsSync(sabotage.patch)) throw new UsageError(`--sabotage ${v.sabotage}: no such file`);
  out(`Proving promise #${number}: running ${check} against the app as it is now${sabotage ? ", then with the sabotage patch" : ", then without the change"}...`);
  const files = footprint(root);
  const proof = await prove({ root, config, check, base: typeof v.base === "string" ? v.base : undefined, sabotage, runDir });
  if (fileHash(join(root, check)) !== before) throw new Error(`${check} changed while it was being proved. Propose again.`);
  // "without" runs in a throwaway worktree; only the "now" run can touch the user's folder
  const warning = sideEffectWarning(changedSince(root, files));

  const rec: ProposalRecord = {
    kind: "proposal", id: newProposalId(), action: "lock", number, sentence, check, checkHash: before,
    proof, reason: v.replaces !== undefined ? `replaces #${number}` : "", proposedAt: new Date().toISOString()
  };
  appendRecord(ledgerPath(root), rec);
  out(proofLine(proof));
  const shots = [proof.now.screenshot && `now: ${proof.now.screenshot}`, proof.without.screenshot && `without: ${proof.without.screenshot}`].filter(Boolean);
  if (shots.length) out(`Screenshots (${shots.join(", ")})`);
  if (warning) out(warning);
  out("");
  out(warning
    ? "Tell the human about the files above, then ask exactly this and end your turn. Only their reply can lock it:"
    : "Ask the human exactly this, then end your turn. Only their reply can lock it:");
  out(pendingMessage([...all, rec]));
  return 0;
}

function cmdStatus(): number {
  const root = requireRoot();
  out(statusText(records(root)));
  return 0;
}

async function cmdCheck(reportPath: string | undefined): Promise<number> {
  const root = requireRoot();
  const { records: all, readError } = readRecords(root);
  const state = loadState(root);
  const tree = safeTreeId(root);
  let outcomes: CheckOutcome[] | null = null;
  const d = await decideStop({
    records: all, readError, mirror: readMirror(root), keyring: buildKeyring(root), hashOf: hashOf(root),
    treeId: tree, state: { ...state, lastGreenTree: null, lastSelectedTree: null, lastBlockKey: null, consecutiveBlocks: 0 },
    changedSince: (from) => (tree === null ? null : changedPaths(root, from, tree)), now: Date.now(), forceAll: true,
    runAll: async (checks, record) => {
      const result = await runAll(root, checks, "check", record, tree);
      outcomes = result.outcomes;
      return result;
    }
  });
  saveState(root, { ...state, lastGreenTree: d.state.lastGreenTree, lastSelectedTree: d.state.lastSelectedTree, coverage: d.state.coverage });
  if (reportPath) {
    // blocked without outcomes = blocked before anything ran (integrity, app didn't start)
    const ran = outcomes !== null || !d.block;
    const report: CheckReport = { ran, reason: ran ? "" : d.systemMessage, outcomes: outcomes ?? [] };
    const abs = resolve(process.cwd(), reportPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(report, null, 2) + "\n");
  }
  if (d.block) {
    out(d.reason);
    return 1;
  }
  out(d.systemMessage || "No active promises yet.");
  return 0;
}

function readReport(path: string): CheckReport {
  const raw: unknown = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
  const r = raw as Partial<CheckReport> | null;
  if (!r || typeof r.ran !== "boolean" || typeof r.reason !== "string" || !Array.isArray(r.outcomes)) {
    throw new Error(`${path} is not a report written by "thisisfine check --report"`);
  }
  return r as CheckReport;
}

/**
 * What a branch does to the promises, against `ref`. Read-only: a CI runner
 * has no key of its own, and diffing must not mint one in its home dir.
 */
function cmdDiff(positionals: string[], v: Record<string, string | boolean | undefined>): number {
  const root = requireRoot();
  const ref = positionals[0];
  if (!ref) throw new UsageError(`diff <base-ref> is required, e.g. thisisfine diff origin/main`);
  const rel = `${STATE_DIR}/promises.jsonl`;
  const text = fileAtRef(root, ref, rel);
  const base = text === null ? [] : parseLedger(text, `${ref}:${rel}`);
  const report = typeof v.report === "string" ? readReport(v.report) : null;
  const d = behaviourDiff({ base, head: records(root), hashOf: hashOf(root), keyring: buildKeyring(root), report });
  out(diffText(d, { base: ref, markdown: v.markdown === true }));
  return d.ok ? 0 : 1;
}

function cmdRetire(positionals: string[], v: Record<string, string | boolean | undefined>): number {
  const root = requireRoot();
  const number = positiveInt(positionals[0], "retire <n>");
  const reason = typeof v.reason === "string" ? v.reason.trim() : "";
  if (!reason) throw new UsageError(`--reason is required: why should promise #${number} stop being enforced?`);
  const all = records(root);
  const p = foldPromises(all).get(number);
  if (!p || p.status !== "active") throw new UsageError(`there is no active promise #${number}`);
  const rec: ProposalRecord = {
    kind: "proposal", id: newProposalId(), action: "retire", number, sentence: p.sentence, check: p.check,
    checkHash: p.checkHash, proof: null, reason, proposedAt: new Date().toISOString()
  };
  appendRecord(ledgerPath(root), rec);
  out("Ask the human exactly this, then end your turn. Only their reply can retire it:");
  out(pendingMessage([...all, rec]));
  return 0;
}

function cmdVerify(strict: boolean): number {
  const root = requireRoot();
  const { records: all, readError } = readRecords(root);
  if (readError) {
    out(`✖ ${STATE_DIR}/promises.jsonl can't be read: ${readError}\n  Run "thisisfine restore" to rebuild it.`);
    return 1;
  }
  // Reads keys, never makes one: this runs on teammates' machines and in CI.
  const keyring = buildKeyring(root);
  const problems = integrityProblems({ records: all, mirror: readMirror(root), keyring, hashOf: hashOf(root) });
  let bad = problems.length > 0;
  out(`thisisfine verify: ${all.length} records`);
  const { errors: keyErrors } = readPublicKeys(root);
  const keys = [...keyring.values()];
  if (keys.length || keyErrors.length) {
    out("Keys:");
    for (const k of keys) {
      const where = k.file ?? (k.alg === "hmac" ? "not shareable (HMAC)" : `not in ${KEYS_DIR}/`);
      out(`  ${k.id}  ${where}${k.local ? "  (this machine)" : ""}`);
    }
    for (const e of keyErrors) out(`  ✖ ${e}`);
  }
  for (const r of all) {
    if (r.kind !== "lock" && r.kind !== "retire") continue;
    const what = `#${r.number} ${r.kind === "lock" ? "lock" : "retirement"} ("${r.words.trim()}", ${shortDate(r.kind === "lock" ? r.confirmedAt : r.retiredAt)})`;
    const key = keyring.get(r.keyId);
    const signature = checkSignature(r, keyring);
    if (signature === "unknown") {
      if (strict) bad = true;
      out(`  ${strict ? "✖" : "·"} ${what}: signed with key ${r.keyId}, and no key in ${KEYS_DIR}/ can check it${r.alg ? "" : " (an old per-machine HMAC key)"}`);
      continue;
    }
    if (signature === "invalid") {
      bad = true;
      out(`  ✖ ${what}: signature doesn't match ${keyLabel(key, r.keyId)}`);
      continue;
    }
    const by = `signed by ${keyLabel(key, r.keyId)}`;
    const words = verifyWords(r.transcriptPath, r.promptId, r.words, r.agent, r.kind === "lock" ? r.confirmedAt : r.retiredAt);
    const note = {
      verified: r.agent === "pi"
        ? `✔ ${by}, and pi's session file has those words as that prompt (pi doesn't record who typed them)`
        : r.agent === "codex"
          ? `✔ ${by}, and Codex's session file shows those words typed in that turn`
          : `✔ ${by}, and the transcript shows a human typing those words`,
      missing: `✔ ${by} (the session transcript isn't on this machine, so the words can't be re-checked)`,
      "not-human": `✖ ${by}, but in the transcript those words didn't come from a human`,
      "not-found": `✖ ${by}, but the transcript has no such prompt`
    }[words];
    if (words === "not-human" || words === "not-found") bad = true;
    out(`  ${note.slice(0, 1)} ${what}: ${note.slice(2)}`);
  }
  if (problems.length) {
    out("Problems:");
    for (const p of problems) out(`  ✖ ${p}`);
    out(`Run "thisisfine restore" to put back what the human confirmed.`);
  } else {
    out("No problems.");
  }
  return bad ? 1 : 0;
}

function cmdRestore(): number {
  const root = requireRoot();
  const path = ledgerPath(root);
  const { records: current, readError } = readRecords(root);
  if (readError) {
    const aside = `${path}.corrupt-${Date.now()}`;
    renameSync(path, aside);
    out(`Moved the unreadable ledger to ${relative(root, aside).replace(/\\/g, "/")}`);
  }
  const keyring = buildKeyring(root);
  const mirror = readMirror(root);
  const { records: fixed, restored } = restoredLedger(current, mirror, (r) => checkSignature(r, keyring) === "invalid");
  if (readError || restored.length || fixed.length !== current.length) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, fixed.map((r) => JSON.stringify(r) + "\n").join(""));
    renameSync(tmp, path);
  }
  for (const r of restored) out(`Restored #${r.number}'s ${r.kind === "lock" ? "lock" : "retirement"} ("${r.words.trim()}")`);
  const dropped = current.length - (fixed.length - restored.length);
  if (dropped > 0) out(`Removed ${dropped} record${dropped === 1 ? "" : "s"} whose signature didn't match`);

  const signer = loadSigner();
  if (signer && fixed.some((r) => (r.kind === "lock" || r.kind === "retire") && r.keyId === signer.id)) {
    const key = publishOwnKey(root, signer);
    if (key.created) out(`Restored ${key.file} (this machine's public key)`);
  }

  let unrestorable = 0;
  for (const p of activePromises(fixed)) {
    const abs = join(root, p.check);
    if (fileHash(abs) === p.checkHash) continue;
    const content = mirrorCheckContent(root, p.checkHash);
    if (content === null) {
      out(`✖ #${p.number}: no confirmed copy of ${p.check} on this machine. Get it back from git history.`);
      unrestorable++;
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    out(`Restored ${p.check} (#${p.number})`);
  }
  out(unrestorable ? "Restore incomplete." : "Everything matches what the human confirmed.");
  return unrestorable ? 1 : 0;
}

// ── hooks ───────────────────────────────────────────────────────────────

interface HookInput {
  /** Absent for Claude Code; "pi" from the pi extension, which gets the neutral result back. */
  agent?: Agent;
  cwd?: string;
  prompt?: string;
  prompt_id?: string;
  /** Codex's id for the turn; Claude Code sends none, so it is what tells Codex apart. */
  turn_id?: string;
  session_id?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/**
 * What a hook decided, before it's shaped for an agent. `context` is for the
 * model, `notice` for the human, `deny` refuses a tool call, `block` refuses
 * a stop and is what the agent must fix.
 */
export interface HookResult {
  context?: string;
  notice?: string;
  deny?: string;
  block?: string;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function hookRoot(input: HookInput): string | null {
  return findRoot(input.cwd || process.cwd());
}

function safeTreeId(root: string): string | null {
  try {
    return treeId(root);
  } catch {
    return null;
  }
}

/** Named after the OS user, so a teammate reading `verify` sees who confirmed each promise. */
function publishOwnKey(root: string, signer: Signer): { file: string; created: boolean } {
  let name = "key";
  try {
    name = userInfo().username;
  } catch {
    // no user name (some containers): "key" is fine, the file is found by content
  }
  return publishPublicKey(root, signer, name);
}

function keyPublishedMessage(file: string): string {
  return `Your public key is in ${file}; commit it so teammates and CI can verify your promises ("thisisfine verify --strict").`;
}

function appendSigned(root: string, rec: LedgerRecord): void {
  appendRecord(ledgerPath(root), rec);
  if (rec.kind !== "lock" && rec.kind !== "retire") return;
  let content: string | null = null;
  if (rec.kind === "lock") {
    try {
      content = readFileSync(join(root, rec.check), "utf8");
    } catch {
      content = null;
    }
  }
  appendMirror(root, rec as SignedRecord, content);
}

/** Which variable says this process was started from inside an agent session, if any. */
export function nestedMarker(env: NodeJS.ProcessEnv = process.env): string | null {
  return NESTED_AGENT_ENVS.find((name) => env[name]) ?? null;
}

/**
 * Codex runs the same hooks.json and reads the same output as Claude Code,
 * so the only difference is where the "yes" is recorded: under a turn id,
 * in Codex's rollout file.
 */
export function hookAgent(input: HookInput): Agent {
  return input.agent ?? (input.turn_id ? "codex" : "claude");
}

async function decideHook(name: string, input: HookInput, root: string): Promise<HookResult> {
  const agent = hookAgent(input);

  if (name === "hook-session") {
    const { records: all } = readRecords(root);
    const pending = pendingMessage(all);
    return { context: sessionContext(cliCommand(), all), ...(pending ? { notice: `thisisfine is waiting for your answer:\n${pending}` } : {}) };
  }

  if (name === "hook-prompt") {
    const { records: all, readError } = readRecords(root);
    if (readError) return {};
    // An agent's shell running `pi -p y` or `claude -p y` reaches this hook
    // with a prompt no person typed. Neither lock nor dismiss: the human's
    // own answer is still to come.
    const marker = nestedMarker();
    if (marker) return { context: nestedContext(marker) };
    const signer = loadOrCreateSigner();
    const d = decidePrompt(all, loadState(root), {
      prompt: input.prompt ?? "", promptId: input.prompt_id ?? input.turn_id ?? "", sessionId: input.session_id ?? "",
      transcriptPath: input.transcript_path ?? "", now: new Date().toISOString(),
      signer, hashOf: hashOf(root), agent
    });
    for (const r of d.append) appendSigned(root, r);
    saveState(root, d.state);
    const published = d.append.some((r) => r.kind === "lock" || r.kind === "retire") ? publishOwnKey(root, signer) : null;
    const notice = [d.systemMessage, published?.created ? keyPublishedMessage(published.file) : ""].filter(Boolean).join(" ");
    return { ...(d.additionalContext ? { context: d.additionalContext } : {}), ...(notice ? { notice } : {}) };
  }

  if (name === "hook-guard") {
    const { records: ledger, readError } = readRecords(root);
    const d = decideGuard({
      toolName: input.tool_name ?? "", toolInput: input.tool_input ?? {}, root, home: homeDir(),
      records: readError ? readMirror(root) : ledger
    });
    return d.deny ? { deny: d.reason } : {};
  }

  // hook-stop
  const { records: all, readError } = readRecords(root);
  const tree = safeTreeId(root);
  const d = await decideStop({
    records: all, readError, mirror: readMirror(root), keyring: buildKeyring(root), hashOf: hashOf(root),
    treeId: tree, state: loadState(root), now: Date.now(),
    changedSince: (from) => (tree === null ? null : changedPaths(root, from, tree)),
    runAll: (checks, record) => runAll(root, checks, "stop", record, tree),
    who: agentName(agent)
  });
  saveState(root, d.state);
  return { ...(d.block ? { block: d.reason } : {}), ...(d.systemMessage ? { notice: d.systemMessage } : {}) };
}

/** Claude Code's hook output, byte for byte what it was before pi existed. */
function forClaude(name: string, r: HookResult): object | null {
  if (name === "hook-session") {
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: r.context ?? "" }, ...(r.notice ? { systemMessage: r.notice } : {}) };
  }
  if (name === "hook-prompt") {
    if (!r.context && !r.notice) return null;
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: r.context ?? "" }, ...(r.notice ? { systemMessage: r.notice } : {}) };
  }
  if (name === "hook-guard") {
    return r.deny ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.deny } } : null;
  }
  if (r.block) return { decision: "block", reason: r.block, systemMessage: r.notice ?? "" };
  return r.notice ? { systemMessage: r.notice } : null;
}

async function runHook(name: string, input: HookInput): Promise<number> {
  const root = hookRoot(input);
  if (!root) return 0;
  const result = await decideHook(name, input, root);
  const json = input.agent === "pi" ? (Object.keys(result).length ? result : null) : forClaude(name, result);
  if (json) out(JSON.stringify(json));
  return 0;
}

// ── entry ───────────────────────────────────────────────────────────────

const HOOKS = new Set(["hook-session", "hook-prompt", "hook-guard", "hook-stop"]);
export const COMMANDS = ["init", "propose", "status", "check", "diff", "retire", "verify", "restore", ...HOOKS];

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    (command ? out : err)(USAGE);
    return command ? 0 : 2;
  }

  if (HOOKS.has(command)) {
    // A hook must never wedge the session: anything unexpected is reported
    // on stderr (Claude Code shows it as a hook error) and the turn goes on.
    try {
      const raw = readStdin();
      return await runHook(command, raw.trim() ? (JSON.parse(raw) as HookInput) : {});
    } catch (e) {
      err(`thisisfine ${command}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  try {
    const { values: v, positionals } = parseArgs({
      args: rest, allowPositionals: true, strict: true,
      options: {
        sentence: { type: "string" }, check: { type: "string" }, base: { type: "string" },
        sabotage: { type: "string" }, "sabotage-note": { type: "string" }, replaces: { type: "string" },
        reason: { type: "string" }, "no-install": { type: "boolean" }, strict: { type: "boolean" },
        report: { type: "string" }, markdown: { type: "boolean" }
      }
    });
    switch (command) {
      case "init": return cmdInit(!v["no-install"]);
      case "propose": return await cmdPropose(v);
      case "status": return cmdStatus();
      case "check": return await cmdCheck(typeof v.report === "string" ? v.report : undefined);
      case "diff": return cmdDiff(positionals, v);
      case "retire": return cmdRetire(positionals, v);
      case "verify": return cmdVerify(v.strict === true);
      case "restore": return cmdRestore();
      default:
        err(`thisisfine: unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      err(`thisisfine ${command}: ${message}`);
      return 2;
    }
    err(`thisisfine ${command}: ${message}`);
    return 1;
  }
}
