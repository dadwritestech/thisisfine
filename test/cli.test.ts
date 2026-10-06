import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileHash } from "../src/hash.ts";
import { readLedger } from "../src/ledger.ts";
import { readMirror } from "../src/mirror.ts";
import { hmacSign, keyIdOf } from "../src/sign.ts";
import type { LedgerRecord } from "../src/types.ts";
import { cleanEnv, commitAll, initRepo, lock, proposal, put, sh, tempDir } from "./helpers.ts";

const BIN = resolve("bin/thisisfine.mjs");
const CHECK = ".thisisfine/checks/1-badge.spec.ts";

function run(args: string[], opts: { cwd: string; home: string; stdin?: unknown }) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd, encoding: "utf8",
    input: opts.stdin === undefined ? "" : JSON.stringify(opts.stdin),
    env: { ...cleanEnv(), THISISFINE_HOME: opts.home }
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

// ── cross-machine verification ──────────────────────────────────────────

const pubFiles = (root: string) => (existsSync(join(root, ".thisisfine/keys")) ? readdirSync(join(root, ".thisisfine/keys")) : []);

test("hook-prompt publishes this machine's public key next to the lock and says to commit it", () => {
  const { root, home, r } = lockOne();
  const files = pubFiles(root);
  assert.equal(files.length, 1);
  const pem = readFileSync(join(root, ".thisisfine/keys", files[0]), "utf8");
  assert.match(pem, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(pem, /PRIVATE/);
  assert.ok(r.json().systemMessage.includes(`Your public key is in .thisisfine/keys/${files[0]}; commit it`), r.stdout);
  const again = run(["hook-prompt"], { cwd: root, home, stdin: { prompt: "y", prompt_id: "pr2", cwd: root } });
  assert.equal(again.stdout, "", "no pending proposal, no second key file, no message");
  assert.equal(pubFiles(root).length, 1);
});

test("a teammate's machine verifies the lock from the committed public key, without making a key", () => {
  const { root } = lockOne();
  const teammate = join(tempDir(), "home");
  const r = run(["verify"], { cwd: root, home: teammate });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✔ #1 lock \("y", .+\): signed by /);
  assert.ok(r.stdout.includes(`signed by ${pubFiles(root)[0]} (the session transcript`), r.stdout);
  assert.match(r.stdout, /transcript isn't on this machine/);
  assert.equal(existsSync(teammate), false, "verify never creates keys or a home dir");
});

test("a teammate's verify catches a lock edited after it was signed", () => {
  const { root } = lockOne();
  const ledger = join(root, ".thisisfine/promises.jsonl");
  writeFileSync(ledger, readFileSync(ledger, "utf8").replaceAll("Badge shows the cart count", "Badge exists"));
  const r = run(["verify"], { cwd: root, home: join(tempDir(), "home") });
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /✖ #1 lock .*signature doesn't match/);
});

test("verify --strict (for CI) fails on records no committed key can check", () => {
  const { root } = lockOne();
  rmSync(join(root, ".thisisfine/keys"), { recursive: true });
  const teammate = join(tempDir(), "home");
  const loose = run(["verify"], { cwd: root, home: teammate });
  assert.equal(loose.code, 0, loose.stdout);
  assert.match(loose.stdout, /· #1 lock .*no key in \.thisisfine\/keys\/ can check it/);
  const strict = run(["verify", "--strict"], { cwd: root, home: teammate });
  assert.equal(strict.code, 1);
  assert.match(strict.stdout, /✖ #1 lock .*no key in \.thisisfine\/keys\/ can check it/);
});

test("a deleted public key blocks the stop on the machine that signed with it; restore writes it back", () => {
  const { root, home } = lockOne();
  rmSync(join(root, ".thisisfine/keys"), { recursive: true });
  const blocked = run(["hook-stop"], { cwd: root, home, stdin: { cwd: root } });
  assert.match(blocked.json().reason, /this machine's public key \([0-9a-f]{16}\) is missing from \.thisisfine\/keys\//);
  const r = run(["restore"], { cwd: root, home });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Restored \.thisisfine\/keys\/.+\.pub/);
  assert.equal(run(["verify", "--strict"], { cwd: root, home: join(tempDir(), "home") }).code, 0);
});

test("a legacy HMAC lock still verifies on the machine that signed it", () => {
  const key = randomBytes(32);
  const p = project();
  mkdirSync(p.home, { recursive: true });
  writeFileSync(join(p.home, "key"), key.toString("hex") + "\n");
  const legacy = hmacSign(lock({ keyId: keyIdOf(key), checkHash: p.hash }), key);
  writeFileSync(join(p.root, ".thisisfine/promises.jsonl"), JSON.stringify(proposal({ checkHash: p.hash })) + "\n" + JSON.stringify(legacy) + "\n");
  const r = run(["verify"], { cwd: p.root, home: p.home });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /✔ #1 lock .*signed by this machine's old HMAC key/);
  assert.equal(run(["verify", "--strict"], { cwd: p.root, home: join(tempDir(), "home") }).code, 1, "elsewhere it can't be checked");
});

// ── CI: check --report and diff ─────────────────────────────────────────

/** #1 locked on "your" machine and committed as the base; CI gets its own empty home. */
function lockedRepo() {
  const p = lockOne();
  initRepo(p.root);
  const base = commitAll(p.root, "lock #1");
  return { ...p, base, ciHome: join(tempDir(), "ci-home") };
}

test("check --report: a block before anything ran is recorded as not run, with the reason", () => {
  const { root, home } = lockOne();
  writeFileSync(join(root, CHECK), "test.skip('badge', () => {});\n");
  const report = join(root, "report.json");
  const r = run(["check", "--report", report], { cwd: root, home });
  assert.equal(r.code, 1);
  const json = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(json.ran, false);
  assert.match(json.reason, /#1's check was changed/);
  assert.deepEqual(json.outcomes, []);
});

test("check --report with nothing locked: ran, nothing to report", () => {
  const { root, home } = project([proposal()]);
  const report = join(root, "report.json");
  assert.equal(run(["check", "--report", report], { cwd: root, home }).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { ran: true, reason: "", outcomes: [] });
});

test("diff: a promise locked since a base without a ledger is new; CI verifies it against the committed public key", () => {
  const p = lockOne();
  initRepo(p.root);
  sh(p.root, "git", ["commit", "-q", "--allow-empty", "-m", "empty"]);
  const base = sh(p.root, "git", ["rev-parse", "HEAD"]);
  commitAll(p.root, "lock #1");
  const r = run(["diff", base], { cwd: p.root, home: join(tempDir(), "ci-home") });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^\+ #1 locked: "Badge shows the cart count" 🟡 unproven \("y", /m);
  assert.doesNotMatch(r.stdout, /Signatures not verified/);
});

test("diff: a confirmation signed with a key that isn't committed is noted, not failed", () => {
  const p = lockOne();
  rmSync(join(p.root, ".thisisfine/keys"), { recursive: true, force: true });
  initRepo(p.root);
  sh(p.root, "git", ["commit", "-q", "--allow-empty", "-m", "empty"]);
  const base = sh(p.root, "git", ["rev-parse", "HEAD"]);
  commitAll(p.root, "lock #1");
  const r = run(["diff", base], { cwd: p.root, home: join(tempDir(), "ci-home") });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 new confirmation was signed with a key that isn't in \.thisisfine\/keys\//);
});

test("diff: a retirement on the branch is listed with the human's reason", () => {
  const { root, home, base, ciHome } = lockedRepo();
  assert.equal(run(["retire", "1", "--reason", "badge removed by design"], { cwd: root, home }).code, 0);
  run(["hook-prompt"], { cwd: root, home, stdin: { prompt: "yes", prompt_id: "pr2", session_id: "s1", transcript_path: "", cwd: root } });
  const r = run(["diff", base], { cwd: root, home: ciHome });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^- #1 retired: "Badge shows the cart count" \(badge removed by design\)$/m);
});

test("diff: on the machine that signed, new confirmations are verified, so no note", () => {
  const p = lockOne();
  initRepo(p.root);
  sh(p.root, "git", ["commit", "-q", "--allow-empty", "-m", "empty"]);
  const r = run(["diff", "HEAD"], { cwd: p.root, home: p.home });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /Signatures not verified/);
});

test("diff fails when the branch rewrote the append-only ledger", () => {
  const { root, base, ciHome } = lockedRepo();
  const ledger = join(root, ".thisisfine/promises.jsonl");
  writeFileSync(ledger, readFileSync(ledger, "utf8").split("\n")[0] + "\n");
  const r = run(["diff", base], { cwd: root, home: ciHome });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^✗ 1 record from [0-9a-f]{7,} is missing here \(#1 lock\)/m);
});

test("diff --report marks a broken promise and fails", () => {
  const { root, base, ciHome } = lockedRepo();
  const report = join(tempDir(), "report.json");
  writeFileSync(report, JSON.stringify({ ran: true, reason: "", outcomes: [{ check: CHECK, status: "failed", message: "Expected: \"2\"\nReceived: \"1\"", screenshot: null }] }));
  const r = run(["diff", base, "--report", report], { cwd: root, home: ciHome });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^✗ #1 broken: "Badge shows the cart count"$/m);
  assert.match(r.stdout, /Received: "1"/);
});

test("diff --markdown is a PR comment: heading and a diff fence", () => {
  const { root, base, ciHome } = lockedRepo();
  const r = run(["diff", base, "--markdown"], { cwd: root, home: ciHome });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^### thisisfine: /);
  assert.match(r.stdout, /```diff\nNo promises changed on this branch\.\n```/);
});

test("diff names a base that doesn't exist instead of treating it as empty", () => {
  const { root, ciHome } = lockedRepo();
  const r = run(["diff", "no-such-branch"], { cwd: root, home: ciHome });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no-such-branch is not a commit/);
  assert.equal(run(["diff"], { cwd: root, home: ciHome }).code, 2, "base is required");
});
