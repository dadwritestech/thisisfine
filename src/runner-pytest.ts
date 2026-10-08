import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { venvPython } from "./boundary.ts";
import type { ProcessRunner } from "./runners.ts";
import type { CheckOutcome } from "./types.ts";
import { STATE_DIR } from "./types.ts";

const MESSAGE_MAX = 3000;

const unescape = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, `"`).replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, "&");

/**
 * One check file's outcome from pytest's JUnit XML. A file with no test
 * cases, or whose every test was skipped, is `missing`: nobody checked the
 * promise. A collection error (pytest's `<error>` on a case named after the
 * file) is a failure with the error as its message.
 */
export function parseJunit(xml: string, check: string): CheckOutcome {
  const cases = [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
  if (cases.length === 0) return { check, status: "missing", message: "pytest found no tests in this check (name them test_…).", screenshot: null };
  const failures: string[] = [];
  let skipped = 0;
  for (const c of cases) {
    const body = c[2] ?? "";
    const name = unescape(/\bname="([^"]*)"/.exec(c[1]!)?.[1] ?? "");
    const bad = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (bad) {
      const message = unescape(/\bmessage="([^"]*)"/.exec(bad[2]!)?.[1] ?? "");
      let detail = unescape(bad[3] ?? "").replace(/\r\n/g, "\n").trim();
      // a collection error's traceback is pytest's own import machinery; its `E` lines are the check's problem
      const said = detail.split("\n").filter((l) => /^E\s/.test(l));
      if (bad[1] === "error" && said.length) detail = said.join("\n");
      failures.push([`${name}: ${message}`.trim(), detail].filter(Boolean).join("\n"));
    } else if (/<skipped\b/.test(body)) {
      skipped++;
    }
  }
  if (failures.length) return { check, status: "failed", message: failures.join("\n\n").slice(0, MESSAGE_MAX), screenshot: null };
  if (skipped === cases.length) return { check, status: "missing", message: "Every test in this check was skipped.", screenshot: null };
  return { check, status: "passed", message: "", screenshot: null };
}

export const pytestRunner: ProcessRunner = {
  kind: "pytest",
  preflight(root) {
    if (existsSync(venvPython(root))) return null;
    return `Python checks run on thisisfine's own venv, and ${STATE_DIR}/.venv isn't there. Run "thisisfine init" (it needs Python 3.9+ on PATH).`;
  },
  command(root, check, reportPath) {
    const dir = join(root, STATE_DIR);
    return {
      file: venvPython(root),
      args: ["-m", "pytest", join(root, check), "-q", "-c", join(dir, "pytest.ini"), "--rootdir", dir, `--junitxml=${reportPath}`],
      cwd: dir,
      env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" }
    };
  },
  parse(_output, reportPath, check) {
    if (!existsSync(reportPath)) return null;
    return parseJunit(readFileSync(reportPath, "utf8"), check);
  }
};
