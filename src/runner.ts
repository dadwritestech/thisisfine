import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { traceErrors } from "./trace.ts";
import type { CheckOutcome } from "./types.ts";
import { STATE_DIR } from "./types.ts";

const CHECKS_PREFIX = `${STATE_DIR}/checks/`;

/** Playwright's own CLI from the project's `.thisisfine/node_modules`, never a global one. */
export function playwrightCli(root: string): string {
  return join(root, STATE_DIR, "node_modules", "@playwright", "test", "cli.js");
}

const ANSI = /\u001b\[[0-9;]*m/g;

interface PwResult {
  status?: string;
  error?: { message?: string };
  errors?: { message?: string }[];
  attachments?: { name?: string; path?: string }[];
}
interface PwSpec {
  tests?: { status?: string; results?: PwResult[] }[];
}
interface PwSuite {
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

interface FileTally {
  statuses: string[];
  message: string;
  screenshot: string | null;
  checkErrors?: string[];
}

function toCheck(file: string): string {
  return CHECKS_PREFIX + file.replace(/\\/g, "/");
}

/**
 * On a timeout Playwright reports a bare "Test timeout of 30000ms exceeded."
 * first and the step that hung (with its call log, e.g. "<div> intercepts
 * pointer events") second. Keep every message, minus any that a more
 * detailed one already contains. `errors[]` messages also end with the code
 * around the failing line, which is what says which assertion it was.
 */
function failureMessage(r: PwResult): string {
  const all = [...(r.errors ?? []), ...(r.error ? [r.error] : [])]
    .map((e) => (e.message ?? "").replace(ANSI, "").trim())
    .filter(Boolean);
  const unique = [...new Set(all)];
  return unique.filter((m) => !unique.some((o) => o !== m && o.includes(m))).join("\n\n");
}

function collect(suite: PwSuite, root: string, into: Map<string, FileTally>): void {
  for (const spec of suite.specs ?? []) {
    if (!suite.file) continue;
    const key = toCheck(suite.file);
    const tally = into.get(key) ?? { statuses: [], message: "", screenshot: null };
    for (const t of spec.tests ?? []) {
      tally.statuses.push(t.status ?? "unexpected");
      if (t.status !== "unexpected" || tally.message) continue;
      const failed = (t.results ?? []).find((r) => r.status !== "passed" && r.status !== "skipped");
      if (!failed) continue;
      tally.message = failureMessage(failed) || `test ${failed.status}`;
      const trace = (failed.attachments ?? []).find((a) => a.name === "trace" && a.path);
      if (trace?.path) tally.checkErrors = traceErrors(trace.path);
      const shot = (failed.attachments ?? []).find((a) => a.name === "screenshot" && a.path);
      if (shot?.path) tally.screenshot = relative(root, shot.path).replace(/\\/g, "/");
    }
    if (!tally.screenshot) {
      const shot = (spec.tests ?? []).flatMap((t) => t.results ?? []).flatMap((r) => r.attachments ?? [])
        .find((a) => a.name === "screenshot" && a.path);
      if (shot?.path) tally.screenshot = relative(root, shot.path).replace(/\\/g, "/");
    }
    into.set(key, tally);
  }
  for (const child of suite.suites ?? []) collect(child, root, into);
}

/**
 * One outcome per requested check, whatever Playwright did. A check with
 * no result at all (deleted, renamed, fails to compile, every test skipped)
 * is `missing`, and missing blocks exactly like failed: a promise nobody
 * checked is not a kept promise.
 */
export function parseReport(report: unknown, root: string, checks: string[]): CheckOutcome[] {
  const r = (report ?? {}) as { suites?: PwSuite[]; errors?: { message?: string }[] };
  const tallies = new Map<string, FileTally>();
  for (const s of r.suites ?? []) collect(s, root, tallies);
  const globalErrors = (r.errors ?? []).map((e) => (e.message ?? "").replace(ANSI, "").trim()).filter(Boolean);

  return checks.map((check): CheckOutcome => {
    const t = tallies.get(check);
    if (!t || t.statuses.length === 0) {
      const name = check.slice(CHECKS_PREFIX.length);
      const related = globalErrors.filter((e) => e.includes(name));
      const message = (related.length ? related : globalErrors).join("\n").slice(0, 2000) || "Playwright reported no result for this check.";
      return { check, status: "missing", message, screenshot: null };
    }
    if (t.statuses.includes("unexpected")) {
      return { check, status: "failed", message: t.message, screenshot: t.screenshot, ...(t.checkErrors ? { checkErrors: t.checkErrors } : {}) };
    }
    if (t.statuses.every((s) => s === "skipped")) return { check, status: "missing", message: "Every test in this check was skipped.", screenshot: null };
    if (t.statuses.includes("flaky")) return { check, status: "flaky", message: "", screenshot: null };
    return { check, status: "passed", message: "", screenshot: t.screenshot };
  });
}

/**
 * What the page throws while loading, e.g. "SyntaxError: … (/app.js:12:5)".
 * Asked only after a check failed: a script that dies on load shows up in
 * the check as nothing more than `Received: "light"`. Best effort, never
 * throws: no errors found and no probe possible both read as [].
 */
export async function pageErrors(root: string, baseUrl: string): Promise<string[]> {
  const playwright = join(root, STATE_DIR, "node_modules", "@playwright", "test", "index.mjs");
  if (!existsSync(playwright)) return [];
  const probe = join(import.meta.dirname, "page-probe.mjs");
  const stdout = await new Promise<string>((resolve) => {
    execFile(process.execPath, [probe, pathToFileURL(playwright).href, baseUrl], { timeout: 45_000, windowsHide: true },
      (_err, out) => resolve(out ?? ""));
  });
  const errors = stdout.split("\n").flatMap((line) => {
    try { return [String(JSON.parse(line))]; } catch { return []; }
  });
  return [...new Set(errors)];
}

const located = / \([^()]*:\d+:\d+\)$/;

/**
 * A check's trace also sees the load its own `page.goto` triggers, so a
 * broken script shows up twice: from the probe with its line, and from the
 * trace with none (see traceErrors). Keep only what the probe didn't say.
 */
export function withoutLoadErrors(during: string[], load: string[]): string[] {
  return during.filter((e) => !load.some((l) => l === e || (!located.test(e) && l.replace(located, "") === e)));
}

/**
 * `--trace` beats `use.trace` in any config, so projects whose config is
 * already frozen by a lock get traces too. Only failures keep theirs.
 */
export function playwrightArgs(cli: string, checks: string[]): string[] {
  return [cli, "test", ...checks.map((c) => c.slice(STATE_DIR.length + 1)), "--config", "playwright.config.mjs", "--trace", "retain-on-failure"];
}

export interface RunOptions {
  root: string;
  checks: string[];
  baseUrl: string;
  runDir: string;
  retries: number;
  timeoutMs: number;
  /** "on" for proofs, so the human can see what they are locking. */
  screenshot?: "on" | "only-on-failure";
}

/**
 * Runs the given checks in one Playwright invocation against an app that is
 * already up at `baseUrl`. Playwright's exit code is ignored; the JSON
 * report is the only source of truth.
 */
export async function runChecks(opts: RunOptions): Promise<CheckOutcome[]> {
  const cli = playwrightCli(opts.root);
  if (!existsSync(cli)) {
    throw new Error(`Playwright isn't installed for thisisfine yet. Run "thisisfine init" (or "npm install" inside ${STATE_DIR}/).`);
  }
  mkdirSync(opts.runDir, { recursive: true });
  const reportPath = join(opts.runDir, "report.json");
  rmSync(reportPath, { force: true });
  const args = playwrightArgs(cli, opts.checks);
  const budget = opts.checks.length * opts.timeoutMs * (opts.retries + 1) + 120_000;
  const output = await new Promise<string>((resolve) => {
    execFile(process.execPath, args, {
      cwd: join(opts.root, STATE_DIR),
      timeout: budget,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        THISISFINE_BASE_URL: opts.baseUrl,
        THISISFINE_REPORT: reportPath,
        THISISFINE_OUTPUT_DIR: join(opts.runDir, "artifacts"),
        THISISFINE_RETRIES: String(opts.retries),
        THISISFINE_TIMEOUT: String(opts.timeoutMs),
        THISISFINE_SCREENSHOT: opts.screenshot ?? "only-on-failure",
        FORCE_COLOR: "0"
      }
    }, (_err, stdout, stderr) => resolve(`${stdout}\n${stderr}`));
  });
  if (!existsSync(reportPath)) {
    throw new Error(`Playwright produced no report. Output:\n${output.trim().split("\n").slice(-20).join("\n")}`);
  }
  return parseReport(JSON.parse(readFileSync(reportPath, "utf8")), opts.root, opts.checks);
}
