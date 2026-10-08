import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { killTree } from "./launcher.ts";
import { STATE_DIR } from "./types.ts";

/**
 * The edges a non-browser check talks to: a `build` step run once per tree,
 * and the `cli` under test, reached through a recording shim. (The third,
 * `start`, is the launcher's.)
 */

/** The Python every pytest check runs on: thisisfine's own venv, never the system's. */
export function venvPython(root: string): string {
  return process.platform === "win32"
    ? join(root, STATE_DIR, ".venv", "Scripts", "python.exe")
    : join(root, STATE_DIR, ".venv", "bin", "python");
}

/**
 * `{app}` is the tree being checked (the project, or the proof's worktree),
 * `{exe}` is ".exe" on Windows so one config serves every OS, and
 * `{python}` is thisisfine's venv.
 */
export function expandTokens(text: string, t: { app: string; python: string }): string {
  return text
    .replaceAll("{app}", t.app.replace(/\\/g, "/"))
    .replaceAll("{exe}", process.platform === "win32" ? ".exe" : "")
    .replaceAll("{python}", t.python.replace(/\\/g, "/"));
}

/**
 * Splits a command the way a shell would split words, quotes and all, but
 * without a shell: the cli is spawned directly so the arguments a check
 * passes arrive byte for byte on every OS. Backslashes are kept as they are,
 * because on Windows they are path separators.
 */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === `"` || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`cli command has an unclosed quote: ${command}`);
  if (inWord) words.push(word);
  return words;
}

export function shimPath(): string {
  return join(import.meta.dirname, "cli-shim.mjs");
}

export interface CliEnvOptions {
  cli: string;
  /** The tree under test. */
  appDir: string;
  /** The project (for the venv, which a proof worktree doesn't have). */
  root: string;
  /** Where the shim appends what it ran and printed; proofs only. */
  evidence?: string;
  /** Where the shim notes a cli it couldn't start at all. */
  shimErrors?: string;
}

/**
 * What a check needs to call the cli. THISISFINE_CLI is a JSON argv prefix
 * (node + shim) because a JSON array survives every language's process API,
 * while a command string would need each one's own quoting rules.
 */
export function cliEnv(o: CliEnvOptions): Record<string, string> {
  const argv = splitCommand(o.cli).map((w) => expandTokens(w, { app: o.appDir, python: venvPython(o.root) }));
  return {
    THISISFINE_CLI: JSON.stringify([process.execPath, shimPath()]),
    THISISFINE_CLI_ARGV: JSON.stringify(argv),
    THISISFINE_CLI_DISPLAY: o.cli,
    ...(o.evidence ? { THISISFINE_EVIDENCE: o.evidence } : {}),
    ...(o.shimErrors ? { THISISFINE_SHIM_ERRORS: o.shimErrors } : {})
  };
}

export interface BuildOptions {
  cwd: string;
  command: string;
  logPath: string;
  timeoutMs: number;
  root: string;
}

/**
 * Runs `build` in one tree. Its output goes to a log, and the tail of it is
 * what the agent sees when the current code doesn't build: same treatment
 * as an app that won't start.
 */
export function runBuild(o: BuildOptions): Promise<{ ok: boolean; output: string }> {
  const command = expandTokens(o.command, { app: o.cwd, python: venvPython(o.root) });
  mkdirSync(dirname(o.logPath), { recursive: true });
  const log = openSync(o.logPath, "a");
  const child = spawn(command, {
    cwd: o.cwd, shell: true, detached: process.platform !== "win32", windowsHide: true,
    stdio: ["ignore", log, log], env: { ...process.env }
  });
  closeSync(log);
  const tail = () => {
    try {
      return readFileSync(o.logPath, "utf8").trimEnd().split("\n").slice(-30).join("\n");
    } catch {
      return "";
    }
  };
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child);
    }, o.timeoutMs);
    timer.unref();
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `"${command}" couldn't start: ${err.message}` });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) return resolve({ ok: true, output: "" });
      const why = timedOut
        ? `timed out after ${Math.round(o.timeoutMs / 100) / 10}s`
        : signal ? `exited with signal ${signal}` : `exited with code ${code}`;
      resolve({ ok: false, output: `build "${command}" ${why}. Last output:\n${tail() || "(no output)"}` });
    });
  });
}
