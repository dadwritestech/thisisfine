import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";

export interface RunningApp {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export interface StartOptions {
  cwd: string;
  /** Shell command; `{port}` is replaced, and PORT is set as well. */
  start: string;
  readyPath: string;
  readyTimeoutMs: number;
  logPath: string;
  env?: Record<string, string>;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** HTTP status of `url`, or null if nothing answers. */
export async function probe(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    await res.body?.cancel();
    return res.status;
  } catch {
    return null;
  }
}

function tail(path: string, lines = 15): string {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no output)";
  }
}

/**
 * Dev servers spawn children (next → node → workers), so killing the shell
 * is not enough: on Windows taskkill takes the whole tree, on POSIX the app
 * runs in its own process group and the group is signalled.
 */
export function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }, 3000).unref();
  }
  return Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5000).unref())]);
}

/**
 * Starts the app on a free port and waits until `readyPath` answers with a
 * status below 500. "Answers below 500" is also the definition of *booted*
 * that proofs rely on: a version of the app that crashes or only serves
 * errors proves nothing about a check that fails against it.
 */
export async function startApp(opts: StartOptions): Promise<RunningApp> {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const command = opts.start.replaceAll("{port}", String(port));
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const log = openSync(opts.logPath, "a");
  const child = spawn(command, {
    cwd: opts.cwd,
    shell: true,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, PORT: String(port), BROWSER: "none", ...opts.env }
  });
  closeSync(log);
  let exit: string | null = null;
  child.once("exit", (code, signal) => {
    exit = signal ? `signal ${signal}` : `code ${code}`;
  });
  child.once("error", (err) => {
    exit = err.message;
  });

  const stop = () => killTree(child);
  const deadline = Date.now() + opts.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (exit) {
      throw new Error(`"${command}" exited with ${exit} before it was ready. Last output:\n${tail(opts.logPath)}`);
    }
    const status = await probe(url + opts.readyPath);
    if (status !== null && status < 500) return { url, port, stop };
    await new Promise((r) => setTimeout(r, 250));
  }
  await stop();
  const seconds = Math.round(opts.readyTimeoutMs / 100) / 10;
  throw new Error(`"${command}" did not answer ${opts.readyPath} below 500 within ${seconds}s. Last output:\n${tail(opts.logPath)}`);
}
