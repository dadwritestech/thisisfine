/**
 * The same story as e2e.test.ts, without a browser: a Python API whose
 * expired tokens got in, and a Go cli whose --dry-run wrote anyway. Each is
 * fixed, proven (the API with a sabotage patch, the cli against the commit
 * before the fix), locked by a human "y", then quietly broken again.
 * Real venv and pip, real go build, the real bin driven through hook JSON.
 *
 * Opt-in, and each half skips when its toolchain isn't on PATH:
 *   THISISFINE_E2E=1 node --test test/e2e-api-cli.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanEnv, commitAll, initRepo, put, tempDir } from "./helpers.ts";

const BIN = resolve("bin/thisisfine.mjs");
const E2E = process.env.THISISFINE_E2E === "1";
const OUT = process.env.THISISFINE_E2E_OUT;
/** Keep what the human and the agent were shown (the README quotes it). */
const keep = (name: string, text: string) => OUT && (mkdirSync(OUT, { recursive: true }), writeFileSync(join(OUT, name), text));

const works = (cmd: string, args: string[]) => spawnSync(cmd, args, { timeout: 30_000, windowsHide: true }).status === 0;
const hasPython = E2E && [["py", "-3"], ["python3"], ["python"]].some(([cmd, ...pre]) => works(cmd!, [...pre, "--version"]));
const hasGo = E2E && works("go", ["version"]);
/** CI sets this: a missing toolchain there is a failure, not a skip. */
const REQUIRED = E2E && process.env.THISISFINE_E2E_REQUIRE === "1";

function project(example: string) {
  const root = tempDir(`tif-e2e-${example}-`);
  const home = join(tempDir("tif-home-"), "home");
  const transcript = join(root, "..", `${root.split(/[\\/]/).pop()}-transcript.jsonl`);
  cpSync(resolve("examples", example), root, { recursive: true });
  initRepo(root);

  const run = (args: string[], stdin?: unknown) => {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd: root, encoding: "utf8", input: stdin === undefined ? "" : JSON.stringify(stdin),
      env: { ...cleanEnv(), THISISFINE_HOME: home }, timeout: 600_000
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout || "{}") as Record<string, any> };
  };
  const hook = (name: string, extra: Record<string, unknown> = {}) =>
    run([name], { session_id: "s1", transcript_path: transcript, cwd: root, hook_event_name: name, ...extra });
  const edit = (rel: string, from: string, to: string) => {
    const path = join(root, rel);
    const before = readFileSync(path, "utf8");
    assert.ok(before.includes(from), `${rel} should contain ${from}`);
    writeFileSync(path, before.replace(from, to));
  };
  /** The human types `words`: Claude Code writes the transcript, then fires the hook. */
  const say = (words: string, id: string) => {
    writeFileSync(transcript, JSON.stringify({ type: "user", promptId: id, origin: { kind: "human" }, message: { role: "user", content: words } }) + "\n");
    return hook("hook-prompt", { prompt: words, prompt_id: id });
  };
  return { root, run, hook, edit, say };
}

const EXPIRY = `        return None, "unknown token"\n`;
const EXPIRY_FIX = `${EXPIRY}    if session["expires"] < time.time():\n        return None, "token expired"\n`;

test("Python API: an expired token gets a 401, proven by sabotage, locked, then broken by a cleanup", { skip: !hasPython && !REQUIRED, timeout: 900_000 }, () => {
  const { root, run, hook, edit, say } = project("tiny-api-py");
  commitAll(root, "Fine Notes API v1");

  const init = run(["init"]);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  assert.match(init.stdout, /Installing pytest/);
  assert.doesNotMatch(init.stdout, /Installing @playwright/, "a Python API needs no browser");
  put(root, ".thisisfine/config.json", JSON.stringify({ start: `"{python}" app.py --port {port}` }, null, 2));
  commitAll(root, "thisisfine init");

  // "Claude, expired tokens still get in." The fix is committed, so a sabotage patch is what takes it away.
  edit("app.py", EXPIRY, EXPIRY_FIX);
  commitAll(root, "reject expired tokens");
  const check = ".thisisfine/checks/1-expired-token.py";
  put(root, check, [
    "from thisisfine_check import api",
    "",
    "",
    "def test_an_expired_token_gets_a_401():",
    `    r = api.get("/me", headers={"Authorization": "Bearer old-token"})`,
    "    assert r.status_code == 401",
    `    assert r.json()["error"] == "token expired"`,
    "",
    "",
    "def test_a_live_token_still_gets_in():",
    `    r = api.get("/me", headers={"Authorization": "Bearer alice-token"})`,
    "    assert r.status_code == 200",
    ""
  ].join("\n"));
  edit("app.py", EXPIRY_FIX, EXPIRY);
  const patch = join(root, "..", `${root.split(/[\\/]/).pop()}-sabotage.patch`);
  writeFileSync(patch, spawnSync("git", ["diff", "--", "app.py"], { cwd: root, encoding: "utf8" }).stdout);
  edit("app.py", EXPIRY, EXPIRY_FIX);

  const propose = run(["propose", "--sentence", "An expired token gets a 401", "--check", check, "--sabotage", patch, "--sabotage-note", "expiry check removed"]);
  assert.equal(propose.code, 0, propose.stdout + propose.stderr);
  assert.match(propose.stdout, /✔ passes now ✔ fails when sabotaged \(expiry check removed\) \(app still boots\)/);
  keep("api-propose.txt", propose.stdout);
  assert.match(propose.stdout, /Evidence now[\s\S]*GET \/me → 401/);
  assert.match(propose.stdout, /Evidence without[\s\S]*GET \/me → 200/);

  assert.match(say("y", "pr-yes").stdout, /locked/i);
  commitAll(root, "promise #1");
  assert.notEqual(hook("hook-stop").json().decision, "block");

  // "Tidy up the auth code": the expiry check goes missing.
  edit("app.py", EXPIRY_FIX, EXPIRY);
  const broken = hook("hook-stop").json();
  assert.equal(broken.decision, "block", JSON.stringify(broken));
  assert.match(broken.reason, /#1/);
  keep("api-stop-broken.txt", broken.reason);
  assert.match(broken.reason, /test_an_expired_token_gets_a_401/);
  assert.match(broken.reason, /assert 200 == 401/);
});

const DRY_RUN = `		note := strings.Join(words, " ")\n`;
const DRY_RUN_FIX = `${DRY_RUN}		if dryRun {\n			fmt.Printf("would add: %s\\n", note)\n			return\n		}\n`;
const FLAG = `			if a != "--dry-run" {`;
const FLAG_FIX = `			if a == "--dry-run" {\n				dryRun = true\n			} else {`;

test("Go cli: --dry-run writes nothing, proven against the commit before, locked, then broken by a refactor", { skip: !hasGo && !REQUIRED, timeout: 900_000 }, () => {
  const { root, run, hook, edit, say } = project("tiny-cli-go");
  commitAll(root, "notes v1");

  const init = run(["init"]);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  assert.match(init.stdout, /CLI command: \{app\}\/\.thisisfine\/bin\/notes\{exe\}/);
  assert.ok(existsSync(join(root, ".thisisfine/tif/tif.go")));
  commitAll(root, "thisisfine init");

  // "Claude, --dry-run still writes." Uncommitted, so HEAD is the version without it.
  edit("cmd/notes/main.go", "		var words []string\n", "		var words []string\n		dryRun := false\n");
  edit("cmd/notes/main.go", FLAG, FLAG_FIX);
  edit("cmd/notes/main.go", DRY_RUN, DRY_RUN_FIX);
  const check = ".thisisfine/checks/1-dry-run/check_test.go";
  put(root, check, [
    "package checks",
    "",
    "import (",
    `	"testing"`,
    "",
    `	"thisisfine.local/checks/tif"`,
    ")",
    "",
    "func TestDryRunWritesNothing(t *testing.T) {",
    `	r := tif.Run(t, "add", "buy milk", "--dry-run")`,
    "	if r.Code != 0 {",
    `		t.Fatalf("exit %d: %s", r.Code, r.Err)`,
    "	}",
    `	if tif.Exists(t, "notes.txt") {`,
    `		t.Fatalf("--dry-run wrote notes.txt: %q", tif.Read(t, "notes.txt"))`,
    "	}",
    "}",
    ""
  ].join("\n"));

  const propose = run(["propose", "--sentence", "notes add --dry-run writes nothing", "--check", check]);
  assert.equal(propose.code, 0, propose.stdout + propose.stderr);
  assert.match(propose.stdout, /✔ passes now ✔ fails on HEAD \(app still boots\)/);
  keep("cli-propose.txt", propose.stdout);
  assert.match(propose.stdout, /Evidence now[\s\S]*would add: buy milk/);
  assert.match(propose.stdout, /Evidence without[\s\S]*added: buy milk/);

  assert.match(say("y", "pr-yes").stdout, /locked/i);
  commitAll(root, "--dry-run + promise #1");
  assert.notEqual(hook("hook-stop").json().decision, "block");

  // "Refactor the argument parsing": the flag is parsed, then never looked at.
  edit("cmd/notes/main.go", DRY_RUN_FIX, `${DRY_RUN}		_ = dryRun\n`);
  const broken = hook("hook-stop").json();
  assert.equal(broken.decision, "block", JSON.stringify(broken));
  assert.match(broken.reason, /#1/);
  keep("cli-stop-broken.txt", broken.reason);
  assert.match(broken.reason, /--dry-run wrote notes\.txt/);
});
