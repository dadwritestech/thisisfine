import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseGoTest } from "../src/runner-go.ts";
import { parseJunit } from "../src/runner-pytest.ts";
import { runChecks, runPerProcess } from "../src/runners.ts";
import type { Exec, ProcessRunner } from "../src/runners.ts";
import { tempDir } from "./helpers.ts";

const PY = ".thisisfine/checks/2-login.py";
const GO = ".thisisfine/checks/3-dry-run/check_test.go";
const PW = ".thisisfine/checks/1-badge.spec.ts";

// ── pytest ──────────────────────────────────────────────────────────────

const junit = (cases: string) => `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest">${cases}</testsuite></testsuites>`;

test("pytest: pass, fail with the assertion, collection error, skip, nothing", () => {
  assert.equal(parseJunit(junit(`<testcase classname="2-login" name="test_ok" time="0.1" />`), PY).status, "passed");

  const failed = parseJunit(junit(`<testcase classname="2-login" name="test_expired"><failure message="assert 200 == 401&#10; +  where 200 = &lt;Response [200]&gt;.status_code">def test_expired():
&gt;       assert r.status_code == 401
E       assert 200 == 401</failure></testcase><testcase name="test_other"/>`), PY);
  assert.equal(failed.status, "failed");
  assert.match(failed.message, /^test_expired: assert 200 == 401/);
  assert.match(failed.message, /<Response \[200\]>/, "entities decoded");
  assert.match(failed.message, />       assert r.status_code == 401/);

  const broken = parseJunit(junit(`<testcase classname="" name=".thisisfine.checks.2-login"><error message="collection failure">SyntaxError: invalid syntax</error></testcase>`), PY);
  assert.equal(broken.status, "failed");
  assert.match(broken.message, /collection failure[\s\S]*SyntaxError/);

  assert.equal(parseJunit(junit(`<testcase name="a"><skipped message="x"/></testcase>`), PY).status, "missing");
  const none = parseJunit(junit(""), PY);
  assert.equal(none.status, "missing");
  assert.match(none.message, /test_/);
});

// ── go test ─────────────────────────────────────────────────────────────

const ev = (o: object) => JSON.stringify({ Time: "2026-10-08T00:00:00Z", Package: "thisisfine.local/checks/checks/3-dry-run", ...o });

test("go: pass, fail with the t.Errorf output, skip, build failure", () => {
  const pass = [ev({ Action: "run", Test: "TestDryRun" }), ev({ Action: "output", Test: "TestDryRun", Output: "=== RUN   TestDryRun\n" }), ev({ Action: "pass", Test: "TestDryRun" }), ev({ Action: "pass" })].join("\n");
  assert.equal(parseGoTest(pass, GO).status, "passed");

  const fail = [
    ev({ Action: "run", Test: "TestDryRun" }),
    ev({ Action: "output", Test: "TestDryRun", Output: "=== RUN   TestDryRun\n" }),
    ev({ Action: "output", Test: "TestDryRun", Output: "    check_test.go:21: --dry-run wrote out.txt\n" }),
    ev({ Action: "output", Test: "TestDryRun/sub", Output: "    check_test.go:30: also this\n" }),
    ev({ Action: "output", Test: "TestDryRun", Output: "--- FAIL: TestDryRun (0.01s)\n" }),
    ev({ Action: "fail", Test: "TestDryRun/sub" }),
    ev({ Action: "fail", Test: "TestDryRun" }),
    ev({ Action: "run", Test: "TestHelp" }),
    ev({ Action: "pass", Test: "TestHelp" }),
    ev({ Action: "fail" })
  ].join("\n");
  const f = parseGoTest(fail, GO);
  assert.equal(f.status, "failed");
  assert.equal(f.message, "TestDryRun:\n    check_test.go:21: --dry-run wrote out.txt\n    check_test.go:30: also this");

  assert.equal(parseGoTest([ev({ Action: "skip", Test: "TestX" }), ev({ Action: "pass" })].join("\n"), GO).status, "missing");

  // Go < 1.24: compiler errors on stderr, then a package-level fail
  const old = `# thisisfine.local/checks/checks/3-dry-run\n./check_test.go:9:2: undefined: tif.Runn\n${ev({ Action: "output", Output: "FAIL\tthisisfine.local/checks/checks/3-dry-run [build failed]\n" })}\n${ev({ Action: "fail" })}`;
  const b = parseGoTest(old, GO);
  assert.equal(b.status, "missing");
  assert.match(b.message, /undefined: tif\.Runn/);
  // Go 1.24+: build-output events
  const neu = [JSON.stringify({ ImportPath: "x", Action: "build-output", Output: "./check_test.go:9:2: undefined: tif.Runn\n" }), JSON.stringify({ ImportPath: "x", Action: "build-fail" }), ev({ Action: "fail" })].join("\n");
  assert.match(parseGoTest(neu, GO).message, /undefined: tif\.Runn/);
});

// ── one process per check ───────────────────────────────────────────────

function fakeRunner(results: Array<"passed" | "failed" | "none">, seen: Array<Record<string, string | undefined>>): { r: ProcessRunner; exec: Exec } {
  let i = 0;
  const r: ProcessRunner = {
    kind: "pytest",
    preflight: () => null,
    command: (_root, check, reportPath) => ({ file: "py", args: [check], cwd: "/x", env: { PYTHONUTF8: "1", REPORT: reportPath } }),
    parse: (_out, reportPath, check) => {
      if (!existsSync(reportPath)) return null;
      const status = results[i - 1]!;
      return { check, status: status as "passed" | "failed", message: status === "failed" ? "boom" : "", screenshot: null };
    }
  };
  const exec: Exec = async (_f, _a, o) => {
    seen.push({ work: o.env.THISISFINE_WORK, base: o.env.THISISFINE_BASE_URL, evidence: o.env.THISISFINE_EVIDENCE, utf8: o.env.PYTHONUTF8, cli: o.env.THISISFINE_CLI });
    const status = results[i++];
    if (status !== "none") writeFileSync(o.env.REPORT!, "x");
    return { output: "some output\nlast line", timedOut: false, error: null };
  };
  return { r, exec };
}

const opts = (runDir: string, retries: number) => ({
  root: "/r", checks: [PY], baseUrl: "http://127.0.0.1:9", runDir, retries, timeoutMs: 1000,
  env: { THISISFINE_CLI: "[]", THISISFINE_EVIDENCE: "/e.txt" }
});

test("per process: env, scratch per attempt, retries, flaky, evidence on the first try only", async () => {
  const seen: Array<Record<string, string | undefined>> = [];
  const { r, exec } = fakeRunner(["failed", "passed"], seen);
  const [o] = await runPerProcess(r, opts(tempDir("tif-rp-"), 1), exec);
  assert.equal(o!.status, "flaky");
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.base, "http://127.0.0.1:9");
  assert.equal(seen[0]!.utf8, "1");
  assert.equal(seen[0]!.cli, "[]");
  assert.notEqual(seen[0]!.work, seen[1]!.work, "a fresh scratch dir per attempt");
  assert.ok(existsSync(seen[0]!.work!));
  assert.equal(seen[0]!.evidence, "/e.txt");
  assert.equal(seen[1]!.evidence, undefined);
});

test("per process: failing twice keeps the first message; no retries means one run", async () => {
  const seen: Array<Record<string, string | undefined>> = [];
  const { r, exec } = fakeRunner(["failed", "failed"], seen);
  const [o] = await runPerProcess(r, opts(tempDir("tif-rp-"), 1), exec);
  assert.equal(o!.status, "failed");
  assert.equal(o!.message, "boom");
  const seen2: Array<Record<string, string | undefined>> = [];
  const f2 = fakeRunner(["failed"], seen2);
  await runPerProcess(f2.r, opts(tempDir("tif-rp-"), 0), f2.exec);
  assert.equal(seen2.length, 1);
});

test("per process: no report, timeout, can't spawn, no toolchain", async () => {
  const seen: Array<Record<string, string | undefined>> = [];
  const { r, exec } = fakeRunner(["none"], seen);
  const [o] = await runPerProcess(r, opts(tempDir("tif-rp-"), 1), exec);
  assert.equal(o!.status, "missing");
  assert.match(o!.message, /produced no result[\s\S]*last line/);
  assert.equal(seen.length, 1, "missing isn't retried");

  const timedOut: Exec = async () => ({ output: "hung here", timedOut: true, error: null });
  const [t] = await runPerProcess(r, opts(tempDir("tif-rp-"), 0), timedOut);
  assert.match(t!.message, /timed out after \d+s[\s\S]*hung here/);

  const noSpawn: Exec = async () => ({ output: "", timedOut: false, error: "spawn go ENOENT" });
  const [n] = await runPerProcess(r, opts(tempDir("tif-rp-"), 0), noSpawn);
  assert.match(n!.message, /couldn't run py: spawn go ENOENT/);

  await assert.rejects(runPerProcess({ ...r, preflight: () => "Run thisisfine init" }, opts(tempDir("tif-rp-"), 0), exec), /Run thisisfine init/);
});

test("runChecks sends each check to its runner and keeps the order asked", async () => {
  const calls: string[] = [];
  const out = await runChecks(
    { root: "/r", checks: [GO, PW, PY, ".thisisfine/checks/x.rb"], baseUrl: "u", runDir: "/runs", retries: 0, timeoutMs: 1 },
    {
      playwright: async (o) => (calls.push(`pw:${o.checks.join()}:${o.runDir}`), o.checks.map((check) => ({ check, status: "passed" as const, message: "", screenshot: null }))),
      process: async (r, o) => (calls.push(`${r.kind}:${o.checks.join()}`), o.checks.map((check) => ({ check, status: "failed" as const, message: r.kind, screenshot: null })))
    }
  );
  assert.deepEqual(out.map((o) => [o.check, o.status]), [[GO, "failed"], [PW, "passed"], [PY, "failed"], [".thisisfine/checks/x.rb", "missing"]]);
  assert.deepEqual(calls.sort(), [`go:${GO}`, `pw:${PW}:${join("/runs", "playwright")}`, `pytest:${PY}`]);
});
