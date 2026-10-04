import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as gitOps from "./git.ts";
import { startApp } from "./launcher.ts";
import type { RunningApp, StartOptions } from "./launcher.ts";
import { runChecks } from "./runner.ts";
import type { RunOptions } from "./runner.ts";
import type { CheckOutcome, Config, Proof } from "./types.ts";

export interface ProveDeps {
  startApp: (o: StartOptions) => Promise<RunningApp>;
  runChecks: (o: RunOptions) => Promise<CheckOutcome[]>;
  snapshotCommit: (root: string) => string;
  defaultBase: (root: string) => string | null;
  resolveRef: (root: string, ref: string) => string | null;
  addWorktree: (root: string, sha: string, dir: string) => void;
  prepareWorktree: (root: string, dir: string, copy: string[]) => void;
  applyPatch: (dir: string, patch: string) => void;
  removeWorktree: (root: string, dir: string) => void;
  tempDir: () => string;
}

const realDeps: ProveDeps = {
  startApp, runChecks, ...gitOps,
  tempDir: () => join(mkdtempSync(join(tmpdir(), "thisisfine-wt-")), "app")
};

export interface ProveOptions {
  root: string;
  config: Config;
  check: string;
  base?: string;
  sabotage?: { patch: string; note: string };
  runDir: string;
  deps?: Partial<ProveDeps>;
}

async function runOnce(d: ProveDeps, o: ProveOptions, cwd: string, label: string, retries: number): Promise<{ booted: boolean; bootError: string; outcome: CheckOutcome | null }> {
  let app: RunningApp;
  try {
    app = await d.startApp({
      cwd, start: o.config.start, readyPath: o.config.readyPath, readyTimeoutMs: o.config.readyTimeoutMs,
      logPath: join(o.runDir, `${label}-app.log`)
    });
  } catch (err) {
    return { booted: false, bootError: err instanceof Error ? err.message : String(err), outcome: null };
  }
  try {
    const [outcome] = await d.runChecks({
      root: o.root, checks: [o.check], baseUrl: app.url, runDir: join(o.runDir, label),
      retries, timeoutMs: o.config.checkTimeoutMs, screenshot: "on"
    });
    return { booted: true, bootError: "", outcome: outcome ?? null };
  } finally {
    await app.stop();
  }
}

/**
 * Red before green, automated: a check only counts if it has been seen to
 * fail. It must pass on the app as it is now, then fail on a version of
 * the app without the behaviour, *while that version still boots*. The
 * agent chooses what "without" means (a base commit or a sabotage patch)
 * but never runs the proof or reports its result: thisisfine does both.
 *
 * Retries are asymmetric on purpose: "now" must pass on the first try (a
 * flaky check is rejected before it can be locked), "without" must fail on
 * both tries (a one-off failure is not proof).
 */
export async function prove(o: ProveOptions): Promise<Proof> {
  const d: ProveDeps = { ...realDeps, ...o.deps };

  const now = await runOnce(d, o, o.root, "now", 0);
  if (!now.booted) throw new Error(`The app didn't start, so nothing can be proven yet.\n${now.bootError}`);
  if (now.outcome?.status !== "passed") {
    const why = now.outcome?.status === "missing" ? now.outcome.message : now.outcome?.message || "no result";
    throw new Error(`The check fails on the current app, so there's nothing to lock yet:\n${why}${now.outcome?.screenshot ? `\nScreenshot: ${now.outcome.screenshot}` : ""}`);
  }

  const proof = (without: Proof["without"], proven: boolean, reason: string): Proof => ({
    proven, reason, now: { screenshot: now.outcome?.screenshot ?? null }, without
  });

  let sha: string;
  let method: "base" | "sabotage";
  let ref: string | null = null;
  if (o.sabotage) {
    method = "sabotage";
    sha = d.snapshotCommit(o.root);
  } else {
    ref = o.base ?? d.defaultBase(o.root);
    if (!ref) {
      return proof({ method: "none", ref: null, note: null, booted: false, failed: false, message: "", screenshot: null }, false,
        "no earlier version to compare against (commit first, or pass --sabotage with a patch that removes the behaviour)");
    }
    const resolved = d.resolveRef(o.root, ref);
    if (!resolved) throw new Error(`--base ${ref}: unknown git revision`);
    method = "base";
    sha = resolved;
  }

  const dir = d.tempDir();
  try {
    d.addWorktree(o.root, sha, dir);
    d.prepareWorktree(o.root, dir, o.config.copy);
    if (o.sabotage) d.applyPatch(dir, o.sabotage.patch);
    const where = method === "sabotage" ? "with the sabotage patch" : `on ${ref}`;
    const w = await runOnce(d, o, dir, "without", 1);
    const without = {
      method, ref, note: o.sabotage?.note ?? null, booted: w.booted,
      failed: w.outcome?.status === "failed", message: w.outcome?.message ?? w.bootError, screenshot: w.outcome?.screenshot ?? null
    };
    if (!w.booted) {
      return proof(without, false, `the app doesn't start ${where}, and a crash proves nothing about the check (try --sabotage with a smaller change)`);
    }
    if (without.failed) {
      return proof(without, true, method === "sabotage" ? `fails with the sabotage patch while the app still boots` : `fails on ${ref} while the app still boots`);
    }
    if (w.outcome?.status === "missing") return proof(without, false, `the check produced no result ${where}: ${without.message}`);
    return proof(without, false, method === "sabotage"
      ? "still passes with the sabotage patch applied, so the check doesn't detect this behaviour"
      : `also passes on ${ref}, so either the behaviour predates it or the check doesn't test it (retry with --sabotage, a patch that removes just this behaviour)`);
  } finally {
    d.removeWorktree(o.root, dir);
  }
}
