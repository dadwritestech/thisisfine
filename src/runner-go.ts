import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ProcessRunner } from "./runners.ts";
import type { CheckOutcome } from "./types.ts";
import { STATE_DIR } from "./types.ts";

const MESSAGE_MAX = 3000;

interface GoEvent {
  Action?: string;
  Test?: string;
  Output?: string;
  ImportPath?: string;
}

/** Go's own progress lines, which say nothing the status doesn't. */
const NOISE = /^\s*(=== (RUN|PAUSE|CONT|NAME)|--- (FAIL|PASS|SKIP):|(FAIL|PASS|ok)\s*$|FAIL\s+\S+\s+[\d.]+s$|ok\s+\S+)/;

/**
 * One check's outcome from `go test -json`. Top-level tests decide the
 * status. A package that doesn't build reports no test at all, so "no
 * tests and a failure" is `missing`, with the compiler's words as message:
 * those are on stderr (older Go) or in build-output events (Go 1.24+).
 */
export function parseGoTest(stream: string, check: string): CheckOutcome {
  const results = new Map<string, string>();
  const output = new Map<string, string[]>();
  const loose: string[] = [];
  for (const line of stream.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e: GoEvent;
    try {
      e = JSON.parse(line) as GoEvent;
    } catch {
      loose.push(line);
      continue;
    }
    if (e.Action === "build-output" && e.Output) loose.push(e.Output.trimEnd());
    if (!e.Test) {
      if (e.Action === "output" && e.Output && !NOISE.test(e.Output)) loose.push(e.Output.trimEnd());
      continue;
    }
    const top = e.Test.split("/")[0]!;
    if (e.Action === "output" && e.Output && !NOISE.test(e.Output)) {
      output.set(top, [...(output.get(top) ?? []), e.Output.trimEnd()]);
    }
    if (!e.Test.includes("/") && (e.Action === "pass" || e.Action === "fail" || e.Action === "skip")) results.set(e.Test, e.Action);
  }
  if (results.size === 0) {
    const why = loose.filter((l) => l.trim()).join("\n").trim();
    return { check, status: "missing", message: (why || "go test reported no tests for this check (name them TestXxx).").slice(0, MESSAGE_MAX), screenshot: null };
  }
  const failed = [...results].filter(([, a]) => a === "fail").map(([t]) => t);
  if (failed.length) {
    const message = failed.map((t) => `${t}:\n${(output.get(t) ?? []).filter((l) => l.trim()).join("\n")}`).join("\n\n");
    return { check, status: "failed", message: message.slice(0, MESSAGE_MAX), screenshot: null };
  }
  if ([...results.values()].every((a) => a === "skip")) return { check, status: "missing", message: "Every test in this check was skipped.", screenshot: null };
  return { check, status: "passed", message: "", screenshot: null };
}

let goChecked: string | null | undefined;

export const goRunner: ProcessRunner = {
  kind: "go",
  preflight() {
    goChecked ??= spawnSync("go", ["version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 }).status === 0
      ? null
      : `Go checks need the go toolchain, and "go version" didn't run. Install Go (https://go.dev/dl/) and make sure it's on PATH.`;
    return goChecked;
  },
  command(root, check, _reportPath, timeoutMs) {
    const dir = check.slice(`${STATE_DIR}/`.length, check.lastIndexOf("/"));
    return {
      file: "go",
      args: ["test", "-json", "-count=1", `-timeout=${Math.ceil(timeoutMs / 1000)}s`, `./${dir}/`],
      cwd: join(root, STATE_DIR),
      // a go.work in the repo must not pull the checks into the app's build, or the app into theirs
      env: { GOWORK: "off", GOFLAGS: "-mod=mod" }
    };
  },
  parse(output, _reportPath, check) {
    return parseGoTest(output, check);
  }
};
