import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileHash } from "../src/hash.ts";
import { readLedger } from "../src/ledger.ts";
import { readMirror } from "../src/mirror.ts";
import type { LedgerRecord } from "../src/types.ts";
import { proposal, put, tempDir } from "./helpers.ts";

const BIN = resolve("bin/thisisfine.mjs");
const CHECK = ".thisisfine/checks/1-badge.spec.ts";

function run(args: string[], opts: { cwd: string; home: string; stdin?: unknown }) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd, encoding: "utf8",
    input: opts.stdin === undefined ? "" : JSON.stringify(opts.stdin),
    env: { ...process.env, THISISFINE_HOME: opts.home }
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) as Record<string, any> };
}

/** A project with a config, one check, and whatever ledger lines are given. */
function project(lines: LedgerRecord[] = []) {
  const root = tempDir();
  const home = join(tempDir(), "home");
  put(root, ".thisisfine/config.json", JSON.stringify({ start: "node server.js" }));
  put(root, CHECK, "import { test } from '@playwright/test';\ntest('badge', async () => {});\n");
  const hash = fileHash(join(root, CHECK));
  put(root, ".thisisfine/promises.jsonl", lines.map((l) => JSON.stringify({ ...l, checkHash: hash }) + "\n").join(""));
  return { root, home, hash };
}

/** Lock #1 through the real hook, the way a human "y" does. */
function lockOne() {
  const p = project([proposal()]);
  const r = run(["hook-prompt"], {
    cwd: p.root, home: p.home,
    stdin: { prompt: "y", prompt_id: "pr1", session_id: "s1", transcript_path: "", cwd: p.root }
  });
  return { ...p, r };
}

test("no command and unknown commands exit 2 with usage", () => {
  const dir = tempDir();
  assert.equal(run([], { cwd: dir, home: dir }).code, 2);
  const r = run(["bogus"], { cwd: dir, home: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command "bogus"/);
  assert.equal(run(["status", "--nope"], { cwd: dir, home: dir }).code, 2);
});

test("every hook is silent outside a thisisfine project", () => {
  const dir = tempDir();
  for (const hook of ["hook-session", "hook-prompt", "hook-guard", "hook-stop"]) {
    const r = run([hook], { cwd: dir, home: join(dir, "home"), stdin: { cwd: dir, prompt: "y" } });
    assert.equal(r.code, 0, hook);
    assert.equal(r.stdout, "", hook);
  }
});

test("hook-prompt: a human y turns a proposal into a signed lock, in the ledger and the mirror", () => {
  const { root, home, hash, r } = lockOne();
  assert.equal(r.code, 0, r.stderr);
  const out = r.json();
  assert.match(out.systemMessage, /Locked promise #1 "Badge shows the cart count"/);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const lock = readLedger(join(root, ".thisisfine/promises.jsonl")).find((l) => l.kind === "lock");
  assert.ok(lock && lock.kind === "lock");
  assert.equal(lock.words, "y");
  assert.equal(lock.checkHash, hash);
  assert.equal(readMirror(root, home).length, 1);
});

test("hook-guard denies editing a locked check in Claude Code's shape", () => {
  const { root, home } = lockOne();
  const r = run(["hook-guard"], { cwd: root, home, stdin: { cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, CHECK) } } });
  assert.equal(r.code, 0);
  const out = r.json();
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /promise #1/);
  assert.equal(run(["hook-guard"], { cwd: root, home, stdin: { cwd: root, tool_name: "Edit", tool_input: { file_path: join(root, "app.js") } } }).stdout, "");
});

test("hook-session gives the agent the CLI and the promise list", () => {
  const { root, home } = lockOne();
  const r = run(["hook-session"], { cwd: root, home, stdin: { cwd: root } });
  const ctx = r.json().hookSpecificOutput.additionalContext as string;
  assert.match(ctx, /#1 Badge shows the cart count/);
  assert.match(ctx, /bin\/thisisfine\.mjs/);
});

test("status lists promises", () => {
  const { root, home } = lockOne();
  const r = run(["status"], { cwd: join(root, ".thisisfine"), home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 active promise/);
  assert.match(r.stdout, /#1\s+🟡 unproven\s+"Badge shows the cart count"/);
});

test("retire asks the human; an unknown number is a usage error", () => {
  const { root, home } = lockOne();
  const r = run(["retire", "1", "--reason", "badge moves to the header"], { cwd: root, home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Retire promise #1 "Badge shows the cart count"\? Reason: badge moves to the header/);
  assert.equal(run(["retire", "7", "--reason", "x"], { cwd: root, home }).code, 2);
  assert.equal(run(["retire", "1"], { cwd: root, home }).code, 2, "reason required");
});

test("hook-stop blocks on a tampered check before running anything, and restore fixes it", () => {
  const { root, home } = lockOne();
  writeFileSync(join(root, CHECK), "test.skip('badge', () => {});\n");
  const blocked = run(["hook-stop"], { cwd: root, home, stdin: { cwd: root, stop_hook_active: false } });
  assert.equal(blocked.code, 0, blocked.stderr);
  const out = blocked.json();
  assert.equal(out.decision, "block");
  assert.match(out.reason, /#1's check was changed after you confirmed it/);

  assert.equal(run(["verify"], { cwd: root, home }).code, 1);
  const restored = run(["restore"], { cwd: root, home });
  assert.equal(restored.code, 0, restored.stdout + restored.stderr);
  assert.match(restored.stdout, /Restored \.thisisfine\/checks\/1-badge\.spec\.ts/);
  assert.match(readFileSync(join(root, CHECK), "utf8"), /test\('badge'/);
  assert.equal(run(["verify"], { cwd: root, home }).code, 0);
});

test("restore brings back a lock that git checkout erased", () => {
  const { root, home } = lockOne();
  const ledger = join(root, ".thisisfine/promises.jsonl");
  const lines = readFileSync(ledger, "utf8").trim().split("\n");
  writeFileSync(ledger, lines[0] + "\n");
  const blocked = run(["hook-stop"], { cwd: root, home, stdin: { cwd: root } });
  assert.match(blocked.json().reason, /missing from \.thisisfine\/promises\.jsonl/);
  const r = run(["restore"], { cwd: root, home });
  assert.match(r.stdout, /Restored #1's lock \("y"\)/);
  assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 2);
});

test("hook-stop with no locked promises lets the agent stop and shows pending questions", () => {
  const { root, home } = project([proposal()]);
  const r = run(["hook-stop"], { cwd: root, home, stdin: { cwd: root } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json().decision, undefined);
  assert.match(r.json().systemMessage, /Lock in promise #1/);
});

test("init on an app it can't recognise says so instead of claiming it's ready", () => {
  const root = tempDir();
  put(root, "server.py", "print('hi')\n");
  const home = join(root, "home");
  const r = run(["init", "--no-install"], { cwd: root, home });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Ready/);
  assert.doesNotMatch(r.stdout, /npm start/, "no made-up start command presented as the answer");
  assert.match(r.stdout, /Not ready yet: set "start" in \.thisisfine\/config\.json/);
  assert.match(r.stdout, /\{port\}/);

  // once the human has set it, init is happy
  const cfgPath = join(root, ".thisisfine/config.json");
  writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace('"npm start"', '"python server.py --port {port}"'));
  const again = run(["init", "--no-install"], { cwd: root, home });
  assert.match(again.stdout, /Start command: python server\.py --port \{port\}/);
  assert.match(again.stdout, /Ready/);
});

test("init writes the scaffold and reports what it detected", () => {
  const root = tempDir();
  put(root, "package.json", JSON.stringify({ scripts: { start: "node server.js" } }));
  const r = run(["init", "--no-install"], { cwd: root, home: join(root, "home") });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Start command: npm start/);
  assert.match(r.stdout, /Not a git repository/);
  assert.match(readFileSync(join(root, ".thisisfine/package.json"), "utf8"), /"@playwright\/test": "1\.61\.0"/);
});
