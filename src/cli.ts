import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, detectConfig, writeScaffold } from "./config.ts";
import { decideStop } from "./gate.ts";
import { repoRoot, treeId } from "./git.ts";
import { decideGuard } from "./guard.ts";
import { fileHash } from "./hash.ts";
import { integrityProblems } from "./integrity.ts";
import { appendRecord, ledgerPath, readLedger } from "./ledger.ts";
import { startApp } from "./launcher.ts";
import { appendMirror, mirrorCheckContent, readMirror } from "./mirror.ts";
import { decidePrompt, newProposalId } from "./prompt.ts";
import { activePromises, foldPromises, nextNumber } from "./promises.ts";
import { prove } from "./prove.ts";
import { pendingMessage, proofLine, sessionContext, shortDate, statusText } from "./render.ts";
import { restoredLedger } from "./restore.ts";
import { runChecks } from "./runner.ts";
import { homeDir, keyIdOf, loadOrCreateKey, verifyRecord } from "./sign.ts";
import { loadState, saveState } from "./state.ts";
import { verifyWords } from "./transcript.ts";
import type { CheckOutcome, LedgerRecord, ProposalRecord, SignedRecord } from "./types.ts";
import { PLAYWRIGHT_VERSION, STATE_DIR } from "./types.ts";

const USAGE = `thisisfine: promises your coding agent can't quietly break.

Usage: thisisfine <command>

  init                         set up .thisisfine/ here and install Playwright ${PLAYWRIGHT_VERSION} into it
  propose --sentence "..." --check .thisisfine/checks/<file>.spec.ts
          [--base <git ref> | --sabotage <patch> --sabotage-note "..."] [--replaces <n>]
                               prove a check, then ask the human to lock it
  status                       list promises
  check                        run every active promise now
  retire <n> --reason "..."    ask the human to retire a promise
  verify                       audit signatures, check files, and the human's words
  restore                      put back exactly what the human confirmed

Hooks (run by Claude Code, not by hand): hook-session, hook-prompt, hook-guard, hook-stop
`;

class UsageError extends Error {}

const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");
const err = (s: string) => process.stderr.write(s.endsWith("\n") ? s : s + "\n");

/** How the agent should call us: the session context hands it this exact string. */
export function cliCommand(): string {
  const bin = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "thisisfine.mjs");
  return `node "${bin.replace(/\\/g, "/")}"`;
}

/** The nearest directory with `.thisisfine/config.json`. Not just `.thisisfine/`: that's also the name of the home dir. */
export function findRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, STATE_DIR, "config.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

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

/** Boot the app once and run these checks against it. */
async function runAll(root: string, checks: string[], label: string): Promise<CheckOutcome[]> {
  const config = loadConfig(root);
  pruneRuns(root);
  const runDir = join(root, STATE_DIR, "runs", stamp(label));
  const app = await startApp({
    cwd: root, start: config.start, readyPath: config.readyPath, readyTimeoutMs: config.readyTimeoutMs,
    logPath: join(runDir, "app.log")
  });
  try {
    return await runChecks({ root, checks, baseUrl: app.url, runDir, retries: 1, timeoutMs: config.checkTimeoutMs });
  } finally {
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
  const { config, detected } = detectConfig(root);
  const written = writeScaffold(root, config);
  const current = loadConfig(root);
  out(`thisisfine init in ${root}`);
  out(`  App: ${detected}`);
  out(`  Start command: ${current.start}   (edit ${STATE_DIR}/config.json if that's wrong)`);
  if (written.length) out(`  Wrote: ${written.join(", ")}`);
  if (!repoRoot(root)) out(`  ⚠ Not a git repository. Proofs compare against an earlier commit, so run "git init" and commit first.`);
  if (install) {
    out(`  Installing @playwright/test ${PLAYWRIGHT_VERSION} into ${STATE_DIR}/ (your own package.json is untouched)...`);
    const dir = join(root, STATE_DIR);
    const npm = spawnSync("npm install --no-audit --no-fund --loglevel=error", { cwd: dir, shell: true, stdio: "inherit" });
    if (npm.status !== 0) throw new Error(`npm install failed in ${dir}`);
    const browsers = spawnSync(process.execPath, [join(dir, "node_modules", "@playwright", "test", "cli.js"), "install", "chromium"], { cwd: dir, stdio: "inherit" });
    if (browsers.status !== 0) throw new Error("Playwright couldn't install Chromium");
  }
  out(`  Ready. Commit ${STATE_DIR}/ so promises travel with the code.`);
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
  const proof = await prove({ root, config, check, base: typeof v.base === "string" ? v.base : undefined, sabotage, runDir });
  if (fileHash(join(root, check)) !== before) throw new Error(`${check} changed while it was being proved. Propose again.`);

  const rec: ProposalRecord = {
    kind: "proposal", id: newProposalId(), action: "lock", number, sentence, check, checkHash: before,
    proof, reason: v.replaces !== undefined ? `replaces #${number}` : "", proposedAt: new Date().toISOString()
  };
  appendRecord(ledgerPath(root), rec);
  out(proofLine(proof));
  const shots = [proof.now.screenshot && `now: ${proof.now.screenshot}`, proof.without.screenshot && `without: ${proof.without.screenshot}`].filter(Boolean);
  if (shots.length) out(`Screenshots (${shots.join(", ")})`);
  out("");
  out("Ask the human exactly this, then end your turn. Only their reply can lock it:");
  out(pendingMessage([...all, rec]));
  return 0;
}

function cmdStatus(): number {
  const root = requireRoot();
  out(statusText(records(root)));
  return 0;
}

async function cmdCheck(): Promise<number> {
  const root = requireRoot();
  const { records: all, readError } = readRecords(root);
  const state = loadState(root);
  const key = loadOrCreateKey();
  const d = await decideStop({
    records: all, readError, mirror: readMirror(root), key, keyId: keyIdOf(key), hashOf: hashOf(root),
    treeId: safeTreeId(root), state: { ...state, lastGreenTree: null, lastBlockKey: null, consecutiveBlocks: 0 },
    runAll: (checks) => runAll(root, checks, "check")
  });
  saveState(root, { ...state, lastGreenTree: d.state.lastGreenTree });
  if (d.block) {
    out(d.reason);
    return 1;
  }
  out(d.systemMessage || "No active promises yet.");
  return 0;
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

function cmdVerify(): number {
  const root = requireRoot();
  const { records: all, readError } = readRecords(root);
  if (readError) {
    out(`✖ ${STATE_DIR}/promises.jsonl can't be read: ${readError}\n  Run "thisisfine restore" to rebuild it.`);
    return 1;
  }
  const key = loadOrCreateKey();
  const keyId = keyIdOf(key);
  const problems = integrityProblems({ records: all, mirror: readMirror(root), key, keyId, hashOf: hashOf(root) });
  let bad = problems.length > 0;
  out(`thisisfine verify: ${all.length} records`);
  for (const r of all) {
    if (r.kind !== "lock" && r.kind !== "retire") continue;
    const what = `#${r.number} ${r.kind === "lock" ? "lock" : "retirement"} ("${r.words.trim()}", ${shortDate(r.kind === "lock" ? r.confirmedAt : r.retiredAt)})`;
    if (r.keyId !== keyId) {
      out(`  · ${what}: signed on another machine (key ${r.keyId}), can't be checked here`);
      continue;
    }
    if (!verifyRecord(r, key)) {
      out(`  ✖ ${what}: signature doesn't match`);
      continue;
    }
    const words = verifyWords(r.transcriptPath, r.promptId, r.words);
    const note = {
      verified: "✔ signed, and the transcript shows a human typing those words",
      missing: "✔ signed (the session transcript is gone, so the words can't be re-checked)",
      "not-human": "✖ signed, but in the transcript those words didn't come from a human",
      "not-found": "✖ signed, but the transcript has no such prompt"
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
  const key = loadOrCreateKey();
  const keyId = keyIdOf(key);
  const mirror = readMirror(root);
  const { records: fixed, restored } = restoredLedger(current, mirror, (r) => r.keyId === keyId && !verifyRecord(r, key));
  if (readError || restored.length || fixed.length !== current.length) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, fixed.map((r) => JSON.stringify(r) + "\n").join(""));
    renameSync(tmp, path);
  }
  for (const r of restored) out(`Restored #${r.number}'s ${r.kind === "lock" ? "lock" : "retirement"} ("${r.words.trim()}")`);
  const dropped = current.length - (fixed.length - restored.length);
  if (dropped > 0) out(`Removed ${dropped} record${dropped === 1 ? "" : "s"} whose signature didn't match`);

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
  cwd?: string;
  prompt?: string;
  prompt_id?: string;
  session_id?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
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

function emit(json: object): void {
  out(JSON.stringify(json));
}

function safeTreeId(root: string): string | null {
  try {
    return treeId(root);
  } catch {
    return null;
  }
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

async function runHook(name: string, input: HookInput): Promise<number> {
  const root = hookRoot(input);
  if (!root) return 0;

  if (name === "hook-session") {
    const { records: all } = readRecords(root);
    const pending = pendingMessage(all);
    emit({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext(cliCommand(), all) },
      ...(pending ? { systemMessage: `thisisfine is waiting for your answer:\n${pending}` } : {})
    });
    return 0;
  }

  if (name === "hook-prompt") {
    const { records: all, readError } = readRecords(root);
    if (readError) return 0;
    const key = loadOrCreateKey();
    const d = decidePrompt(all, loadState(root), {
      prompt: input.prompt ?? "", promptId: input.prompt_id ?? "", sessionId: input.session_id ?? "",
      transcriptPath: input.transcript_path ?? "", now: new Date().toISOString(),
      key, keyId: keyIdOf(key), hashOf: hashOf(root)
    });
    for (const r of d.append) appendSigned(root, r);
    saveState(root, d.state);
    if (d.additionalContext || d.systemMessage) {
      emit({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: d.additionalContext },
        ...(d.systemMessage ? { systemMessage: d.systemMessage } : {})
      });
    }
    return 0;
  }

  if (name === "hook-guard") {
    const { records: ledger, readError } = readRecords(root);
    const d = decideGuard({
      toolName: input.tool_name ?? "", toolInput: input.tool_input ?? {}, root, home: homeDir(),
      records: readError ? readMirror(root) : ledger
    });
    if (d.deny) emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } });
    return 0;
  }

  if (name === "hook-stop") {
    const { records: all, readError } = readRecords(root);
    const key = loadOrCreateKey();
    const d = await decideStop({
      records: all, readError, mirror: readMirror(root), key, keyId: keyIdOf(key), hashOf: hashOf(root),
      treeId: safeTreeId(root), state: loadState(root), runAll: (checks) => runAll(root, checks, "stop")
    });
    saveState(root, d.state);
    if (d.block) emit({ decision: "block", reason: d.reason, systemMessage: d.systemMessage });
    else if (d.systemMessage) emit({ systemMessage: d.systemMessage });
    return 0;
  }
  return 2;
}

// ── entry ───────────────────────────────────────────────────────────────

const HOOKS = new Set(["hook-session", "hook-prompt", "hook-guard", "hook-stop"]);
export const COMMANDS = ["init", "propose", "status", "check", "retire", "verify", "restore", ...HOOKS];

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
        reason: { type: "string" }, "no-install": { type: "boolean" }
      }
    });
    switch (command) {
      case "init": return cmdInit(!v["no-install"]);
      case "propose": return await cmdPropose(v);
      case "status": return cmdStatus();
      case "check": return await cmdCheck();
      case "retire": return cmdRetire(positionals, v);
      case "verify": return cmdVerify();
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
