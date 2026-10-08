import { test } from "node:test";
import assert from "node:assert/strict";
import { prove } from "../src/prove.ts";
import type { ProveDeps } from "../src/prove.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULTS } from "../src/config.ts";
import { tempDir } from "./helpers.ts";
import type { CheckOutcome } from "../src/types.ts";

const ROOT = "/proj";
const CHECK = ".thisisfine/checks/1-badge.spec.ts";
const config = { start: "node server.js", ...DEFAULTS };

/**
 * Fakes keyed by where the app was started: the real tree is ROOT, the
 * proof worktree is anything else. `nowStatus` / `withoutStatus` say how the
 * check behaves in each; `withoutBoots: false` makes the worktree app crash.
 */
function deps(o: { nowStatus?: CheckOutcome["status"]; nowMessage?: string; withoutStatus?: CheckOutcome["status"]; withoutBoots?: boolean; base?: string | null; builds?: { now?: boolean; without?: boolean } }) {
  const calls: string[] = [];
  const d: ProveDeps = {
    runBuild: async (b) => {
      const where = b.cwd === ROOT ? "now" : "without";
      calls.push(`build:${where}`);
      return o.builds?.[where] === false ? { ok: false, output: "undefined: Foo" } : { ok: true, output: "" };
    },
    startProxy: async (target) => (calls.push(`proxy:${target}`), { url: `${target}#proxy`, stop: async () => void calls.push("proxy-stop") }),
    startApp: async (s) => {
      const where = s.cwd === ROOT ? "now" : "without";
      calls.push(`start:${where}`);
      if (where === "without" && o.withoutBoots === false) throw new Error("exited with code 1");
      return { url: `http://${where}`, port: 1, stop: async () => void calls.push(`stop:${where}`) };
    },
    runChecks: async (r) => {
      const where = r.baseUrl.startsWith("http://now") || (!r.baseUrl && !r.env?.THISISFINE_CLI_ARGV?.includes("wt")) ? "now" : "without";
      calls.push(`run:${where}:retries=${r.retries}`);
      const status = where === "now" ? (o.nowStatus ?? "passed") : (o.withoutStatus ?? "failed");
      const message = where === "now" && o.nowMessage ? o.nowMessage : status === "failed" ? "expected 3, got 0" : "";
      return [{ check: CHECK, status, message, screenshot: `${where}.png` }];
    },
    snapshotCommit: () => (calls.push("snapshot"), "snap"),
    defaultBase: () => (o.base === undefined ? "HEAD~1" : o.base),
    resolveRef: (_r, ref) => (ref === "nope" ? null : `sha-of-${ref}`),
    addWorktree: (_r, sha) => void calls.push(`worktree:${sha}`),
    prepareWorktree: () => void calls.push("prepare"),
    applyPatch: (_d, p) => void calls.push(`patch:${p}`),
    removeWorktree: () => void calls.push("remove"),
    tempDir: () => "/tmp/wt"
  };
  return { d, calls };
}

const run = (o: Parameters<typeof deps>[0], extra: { base?: string; sabotage?: { patch: string; note: string } } = {}) => {
  const { d, calls } = deps(o);
  return { calls, result: prove({ root: ROOT, config, check: CHECK, runDir: "/runs/x", deps: d, ...extra }) };
};

test("passes now + fails on HEAD~1 while booting = proven", async () => {
  const { result, calls } = run({});
  const proof = await result;
  assert.equal(proof.proven, true);
  assert.equal(proof.without.method, "base");
  assert.equal(proof.without.ref, "HEAD~1");
  assert.equal(proof.without.message, "expected 3, got 0");
  assert.equal(proof.now.screenshot, "now.png");
  assert.ok(calls.includes("run:now:retries=0"), "now must pass first time");
  assert.ok(calls.includes("run:without:retries=1"), "without must fail twice");
  assert.ok(calls.includes("worktree:sha-of-HEAD~1"));
  assert.ok(calls.includes("stop:without") && calls.includes("remove"), "cleans up");
});

test("a check that fails now is refused outright", async () => {
  await assert.rejects(run({ nowStatus: "failed" }).result, /fails on the current app/);
});

test("a browser that can't start is the environment, not a failing check", async () => {
  const nowMessage = "Error: browserType.launch: spawn EPERM\nCall log:\n  - <launching> C:\\ms-playwright\\chrome-headless-shell.exe --headless";
  await assert.rejects(run({ nowStatus: "failed", nowMessage }).result, (e: Error) => {
    assert.doesNotMatch(e.message, /fails on the current app/);
    assert.match(e.message, /couldn't start the browser/);
    assert.match(e.message, /spawn EPERM/);
    assert.match(e.message, /sandbox/);
    assert.doesNotMatch(e.message, /--headless/, "the launch command line is noise");
    return true;
  });
});

test("passing on the base too = unproven, with a hint", async () => {
  const proof = await run({ withoutStatus: "passed" }).result;
  assert.equal(proof.proven, false);
  assert.match(proof.reason, /also passes on HEAD~1/);
  assert.match(proof.reason, /--sabotage/);
});

test("a base that doesn't boot proves nothing", async () => {
  const { result, calls } = run({ withoutBoots: false });
  const proof = await result;
  assert.equal(proof.proven, false);
  assert.equal(proof.without.booted, false);
  assert.match(proof.reason, /doesn't start/);
  assert.ok(calls.includes("remove"));
});

test("sabotage snapshots the working tree and applies the patch", async () => {
  const { result, calls } = run({}, { sabotage: { patch: "/p.patch", note: "badge hidden" } });
  const proof = await result;
  assert.equal(proof.proven, true);
  assert.equal(proof.without.method, "sabotage");
  assert.equal(proof.without.note, "badge hidden");
  assert.deepEqual(calls.filter((c) => /snapshot|worktree|patch/.test(c)), ["snapshot", "worktree:snap", "patch:/p.patch"]);
});

test("no earlier version and no sabotage = unproven, method none", async () => {
  const { result, calls } = run({ base: null });
  const proof = await result;
  assert.equal(proof.proven, false);
  assert.equal(proof.without.method, "none");
  assert.ok(!calls.some((c) => c.startsWith("worktree")));
});

test("an unknown --base is an error", async () => {
  await assert.rejects(run({}, { base: "nope" }).result, /unknown/);
});

test("a cli-only app: no server, the check gets the cli, and build runs in both trees", async () => {
  const { d, calls } = deps({});
  let seen: Record<string, string> | undefined;
  const runChecks = d.runChecks;
  d.runChecks = async (r) => ((seen ??= r.env), runChecks(r));
  const proof = await prove({ root: ROOT, config: { cli: "{app}/bin/tool", build: "go build -o bin/tool .", ...DEFAULTS }, check: ".thisisfine/checks/2-x.py", runDir: "/runs/x", deps: d });
  assert.equal(proof.proven, true);
  assert.ok(!calls.some((c) => c.startsWith("start:")), "nothing to start");
  assert.deepEqual(calls.filter((c) => c.startsWith("build:")), ["build:now", "build:without"]);
  assert.deepEqual(JSON.parse(seen!.THISISFINE_CLI_ARGV!), ["/proj/bin/tool"]);
  assert.match(seen!.THISISFINE_EVIDENCE!, /now[\\/]evidence\.txt$/);
});

test("the current code not building stops the proof; the old code not building proves nothing", async () => {
  const cli = { cli: "tool", build: "make", ...DEFAULTS };
  await assert.rejects(prove({ root: ROOT, config: cli, check: CHECK, runDir: "/runs/x", deps: deps({ builds: { now: false } }).d }), /build failed[\s\S]*undefined: Foo/);
  const proof = await prove({ root: ROOT, config: cli, check: CHECK, runDir: "/runs/x", deps: deps({ builds: { without: false } }).d });
  assert.equal(proof.proven, false);
  assert.match(proof.reason, /doesn't build on HEAD~1, and a crash proves nothing/);
});

test("API checks go through the evidence proxy; browser checks that use page don't", async () => {
  const { d, calls } = deps({});
  await prove({ root: ROOT, config, check: ".thisisfine/checks/2-api.py", runDir: "/runs/x", deps: d });
  assert.ok(calls.includes("proxy:http://now") && calls.includes("proxy:http://without"));
  assert.equal(calls.filter((c) => c === "proxy-stop").length, 2);
  const browser = deps({});
  await prove({ root: ROOT, config, check: CHECK, runDir: "/runs/x", deps: browser.d });
  assert.ok(!browser.calls.some((c) => c.startsWith("proxy:")), "unreadable source counts as a browser check");
});

test("evidence lands in the proof, root-relative; a cli that can't run means it didn't boot", async () => {
  const root = tempDir("tif-prove-");
  const { d } = deps({});
  d.startApp = async (s) => ({ url: s.cwd === root ? "http://now" : "http://without", port: 1, stop: async () => {} });
  d.startProxy = async (target, file) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `GET /me → ${target.endsWith("now") ? 200 : 401}\n`);
    return { url: target, stop: async () => {} };
  };
  const proof = await prove({ root, config, check: ".thisisfine/checks/2-api.py", runDir: join(root, ".thisisfine", "runs", "p"), deps: d });
  assert.equal(proof.now.evidence, ".thisisfine/runs/p/now/evidence.txt");
  assert.equal(proof.without.evidence, ".thisisfine/runs/p/without/evidence.txt");

  const broken = deps({}).d;
  const inner = broken.runChecks;
  broken.runChecks = async (r) => {
    if (r.runDir.endsWith("without")) {
      mkdirSync(dirname(r.env!.THISISFINE_SHIM_ERRORS!), { recursive: true });
      writeFileSync(r.env!.THISISFINE_SHIM_ERRORS!, "couldn't start bin/tool: spawn ENOENT\n");
    }
    return inner(r);
  };
  const p2 = await prove({ root, config: { cli: "bin/tool", ...DEFAULTS }, check: ".thisisfine/checks/2-x.py", runDir: join(root, "runs2"), deps: broken });
  assert.equal(p2.proven, false);
  assert.equal(p2.without.booted, false);
  assert.match(p2.without.message, /couldn't start bin\/tool/);
});
