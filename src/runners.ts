import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkKind } from "./checks.ts";
import type { CheckKind } from "./checks.ts";
import { killTree } from "./launcher.ts";
import { runPlaywright } from "./runner.ts";
import type { RunOptions } from "./runner.ts";
import { goRunner } from "./runner-go.ts";
import { pytestRunner } from "./runner-pytest.ts";
import type { CheckOutcome } from "./types.ts";

export type { RunOptions };

/**
 * A runner that takes one process per check: pytest and go test. One
 * process each costs a little speed and buys isolation: a check that
 * doesn't compile, or hangs, can only take itself down.
 */
export interface ProcessRunner {
  kind: CheckKind;
  /** Null when the toolchain is there; otherwise what to do about it. */
  preflight(root: string): string | null;
  command(root: string, check: string, reportPath: string, timeoutMs: number): { file: string; args: string[]; cwd: string; env: Record<string, string> };
  /** Null when the run left nothing to read (no report file). */
  parse(output: string, reportPath: string, check: string): CheckOutcome | null;
}

export interface Exec {
  (file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ output: string; timedOut: boolean; error: string | null }>;
}

/** Spawns without a shell, kills the whole tree on timeout, never throws. */
export const realExec: Exec = (file, args, o) => new Promise((resolve) => {
  const child = spawn(file, args, { cwd: o.cwd, env: o.env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const timer = setTimeout(() => {
    timedOut = true;
    void killTree(child);
  }, o.timeoutMs);
  timer.unref();
  child.once("error", (err) => {
    clearTimeout(timer);
    resolve({ output: stdout + stderr, timedOut, error: err.message });
  });
  child.once("close", () => {
    clearTimeout(timer);
    resolve({ output: `${stdout}\n${stderr}`, timedOut, error: null });
  });
});

const tail = (s: string, n = 20) => s.trim().split(/\r?\n/).slice(-n).join("\n");

/**
 * Runs each check in its own process, retrying a failure `retries` times
 * (failed then passed = flaky). Every attempt gets a fresh scratch dir for
 * the cli (THISISFINE_WORK). Evidence is only kept for the first attempt,
 * so a proof shows one clean story.
 */
export async function runPerProcess(r: ProcessRunner, o: RunOptions, exec: Exec = realExec): Promise<CheckOutcome[]> {
  const problem = r.preflight(o.root);
  if (problem) throw new Error(problem);
  const outcomes: CheckOutcome[] = [];
  for (const check of o.checks) {
    const slug = check.replace(/^.*checks\//, "").replace(/\/check_test\.go$/, "").replace(/[^\w.-]+/g, "_");
    let first: CheckOutcome | null = null;
    let final: CheckOutcome | null = null;
    for (let attempt = 0; attempt <= o.retries; attempt++) {
      const dir = join(o.runDir, slug, `try-${attempt + 1}`);
      mkdirSync(join(dir, "work"), { recursive: true });
      const reportPath = join(dir, "report.xml");
      rmSync(reportPath, { force: true });
      const budget = o.timeoutMs * 3 + 60_000;
      const cmd = r.command(o.root, check, reportPath, budget);
      const env: NodeJS.ProcessEnv = { ...process.env, ...o.env, ...cmd.env, THISISFINE_BASE_URL: o.baseUrl, THISISFINE_WORK: join(dir, "work") };
      if (attempt > 0) delete env.THISISFINE_EVIDENCE;
      const res = await exec(cmd.file, cmd.args, { cwd: cmd.cwd, env, timeoutMs: budget });
      let outcome: CheckOutcome;
      if (res.error) {
        outcome = { check, status: "missing", message: `couldn't run ${cmd.file}: ${res.error}`, screenshot: null };
      } else if (res.timedOut) {
        outcome = { check, status: "missing", message: `timed out after ${Math.round(budget / 1000)}s and was stopped. Last output:\n${tail(res.output)}`, screenshot: null };
      } else {
        outcome = r.parse(res.output, reportPath, check)
          ?? { check, status: "missing", message: `${r.kind} produced no result. Last output:\n${tail(res.output)}`, screenshot: null };
      }
      first ??= outcome;
      final = outcome;
      if (outcome.status !== "failed") break;
    }
    if (first!.status === "failed" && final!.status === "passed") outcomes.push({ check, status: "flaky", message: "", screenshot: null });
    else outcomes.push(first!.status === "failed" ? first! : final!);
  }
  return outcomes;
}

export interface RunnerDeps {
  playwright: (o: RunOptions) => Promise<CheckOutcome[]>;
  process: (r: ProcessRunner, o: RunOptions) => Promise<CheckOutcome[]>;
}

const realDeps: RunnerDeps = { playwright: runPlaywright, process: (r, o) => runPerProcess(r, o) };

/**
 * Every check, whatever runs it, in the order asked. Playwright checks go
 * in one invocation (as before); pytest and Go checks one process each.
 * A check no runner owns is `missing`, which blocks like a failure.
 */
export async function runChecks(o: RunOptions, deps: Partial<RunnerDeps> = {}): Promise<CheckOutcome[]> {
  const d = { ...realDeps, ...deps };
  const groups = new Map<CheckKind | null, string[]>();
  for (const c of o.checks) {
    const k = checkKind(c);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const results = new Map<string, CheckOutcome>();
  for (const [kind, checks] of groups) {
    let outs: CheckOutcome[];
    const sub = { ...o, checks, runDir: groups.size > 1 ? join(o.runDir, kind ?? "unknown") : o.runDir };
    if (kind === "playwright") outs = await d.playwright(sub);
    else if (kind === "pytest") outs = await d.process(pytestRunner, sub);
    else if (kind === "go") outs = await d.process(goRunner, sub);
    else outs = checks.map((check) => ({ check, status: "missing" as const, message: "thisisfine doesn't know how to run this file.", screenshot: null }));
    for (const out of outs) results.set(out.check, out);
  }
  return o.checks.map((c) => results.get(c) ?? { check: c, status: "missing", message: "no result", screenshot: null });
}
