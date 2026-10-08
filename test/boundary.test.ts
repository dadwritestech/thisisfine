import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cliEnv, expandTokens, runBuild, splitCommand } from "../src/boundary.ts";
import { put, tempDir } from "./helpers.ts";

test("a cli command splits like a shell would, without running one", () => {
  assert.deepEqual(splitCommand("go run ./cmd/tool"), ["go", "run", "./cmd/tool"]);
  assert.deepEqual(splitCommand(`node "{app}/bin/my tool.js" --flag='a b'`), ["node", "{app}/bin/my tool.js", "--flag=a b"]);
  assert.deepEqual(splitCommand(`C:\\tools\\x.exe  -v`), ["C:\\tools\\x.exe", "-v"], "backslashes are path separators, not escapes");
  assert.deepEqual(splitCommand(`""`), [""]);
  assert.throws(() => splitCommand(`node "unclosed`), /unclosed quote/);
});

test("tokens: {app}, {exe}, {python}", () => {
  const t = expandTokens("{app}/bin/tool{exe} {python}", { app: "/r", python: "/r/.thisisfine/.venv/bin/python" });
  assert.equal(t, `/r/bin/tool${process.platform === "win32" ? ".exe" : ""} /r/.thisisfine/.venv/bin/python`);
});

test("cliEnv points checks at the shim and hands it the expanded argv", () => {
  const env = cliEnv({ cli: `node "{app}/cli.js" --quiet`, appDir: "/r", root: "/r", evidence: "/runs/e.txt", shimErrors: "/runs/s.txt" });
  const [node, shim] = JSON.parse(env.THISISFINE_CLI!) as string[];
  assert.equal(node, process.execPath);
  assert.match(shim!, /cli-shim\.mjs$/);
  assert.ok(existsSync(shim!));
  assert.deepEqual(JSON.parse(env.THISISFINE_CLI_ARGV!), ["node", "/r/cli.js", "--quiet"]);
  assert.equal(env.THISISFINE_CLI_DISPLAY, `node "{app}/cli.js" --quiet`);
  assert.equal(env.THISISFINE_EVIDENCE, "/runs/e.txt");
  assert.equal(env.THISISFINE_SHIM_ERRORS, "/runs/s.txt");
});

test("build: success, failure with its output, and a timeout", async () => {
  const dir = tempDir("tif-build-");
  const ok = await runBuild({ cwd: dir, command: `node -e "require('fs').writeFileSync('built.txt','x')"`, logPath: join(dir, "b.log"), timeoutMs: 30_000, root: dir });
  assert.equal(ok.ok, true);
  assert.ok(existsSync(join(dir, "built.txt")), "runs in cwd");
  const bad = await runBuild({ cwd: dir, command: `node -e "console.error('syntax error in main.go'); process.exit(2)"`, logPath: join(dir, "c.log"), timeoutMs: 30_000, root: dir });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /syntax error in main\.go/);
  assert.match(bad.output, /exited with code 2/);
  const slow = await runBuild({ cwd: dir, command: `node -e "setTimeout(()=>{}, 60000)"`, logPath: join(dir, "d.log"), timeoutMs: 1500, root: dir });
  assert.equal(slow.ok, false);
  assert.match(slow.output, /timed out after 1\.5s/);
});

/** A tiny CLI that reports where and how it was run. */
const FIXTURE_CLI = `
const os = require("os"), fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (process.argv[2] === "save") fs.writeFileSync(require("path").join(os.homedir(), ".toolrc"), "saved");
  console.log(JSON.stringify({ args: process.argv.slice(2), home: os.homedir(), cwd: process.cwd(), input, appdata: process.env.APPDATA || null, xdg: process.env.XDG_CONFIG_HOME }));
  console.error("warn: careful");
  process.exit(Number(process.env.EXIT_WITH || 0));
});
`;

function shim(scratch: string, args: string[], extra: Record<string, string> = {}, input = "") {
  const app = tempDir("tif-app-");
  put(app, "tool.cjs", FIXTURE_CLI);
  const env = cliEnv({ cli: `node "{app}/tool.cjs"`, appDir: app, root: app, evidence: join(scratch, "evidence.txt"), shimErrors: join(scratch, "shim-errors.txt") });
  const [node, shimPath] = JSON.parse(env.THISISFINE_CLI!) as string[];
  const r = spawnSync(node!, [shimPath!, ...args], { input, encoding: "utf8", env: { ...process.env, ...env, THISISFINE_WORK: join(scratch, "work"), ...extra } });
  return r;
}

test("the shim runs the cli in the scratch dir with a scratch home, and passes everything through", () => {
  const scratch = tempDir("tif-scratch-");
  mkdirSync(join(scratch, "work"), { recursive: true });
  const r = shim(scratch, ["save", "two words", `quote"d`, "50%"], { EXIT_WITH: "3" }, "piped in");
  assert.equal(r.status, 3, r.stderr);
  const seen = JSON.parse(r.stdout) as { args: string[]; home: string; cwd: string; input: string; appdata: string | null; xdg: string };
  assert.deepEqual(seen.args, ["save", "two words", `quote"d`, "50%"], "arguments arrive exactly");
  assert.equal(seen.input, "piped in");
  assert.equal(seen.cwd.toLowerCase(), join(scratch, "work").toLowerCase());
  assert.equal(seen.home.toLowerCase(), join(scratch, "home").toLowerCase());
  assert.ok(seen.xdg.toLowerCase().startsWith(join(scratch, "home").toLowerCase()));
  if (process.platform === "win32") assert.ok(seen.appdata!.toLowerCase().startsWith(join(scratch, "home").toLowerCase()));
  assert.equal(readFileSync(join(scratch, "home", ".toolrc"), "utf8"), "saved", "the tool's config landed in the scratch home");
  assert.match(r.stderr, /warn: careful/);

  const evidence = readFileSync(join(scratch, "evidence.txt"), "utf8");
  assert.match(evidence, /^\$ node "\{app\}\/tool\.cjs" save "two words" 'quote"d' 50%/m);
  assert.match(evidence, /"args":\["save"/);
  assert.match(evidence, /warn: careful/);
  assert.match(evidence, /\[exit 3\]/);
  assert.equal(existsSync(join(scratch, "shim-errors.txt")), false);
});

test("a cli that can't be started is recorded as a spawn failure, not as a failing check", () => {
  const scratch = tempDir("tif-scratch-");
  const env = cliEnv({ cli: "{app}/missing-tool{exe}", appDir: scratch, root: scratch, shimErrors: join(scratch, "shim-errors.txt") });
  const [node, shimPath] = JSON.parse(env.THISISFINE_CLI!) as string[];
  const r = spawnSync(node!, [shimPath!, "--help"], { encoding: "utf8", env: { ...process.env, ...env, THISISFINE_WORK: join(scratch, "work") } });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /couldn't start/);
  assert.match(readFileSync(join(scratch, "shim-errors.txt"), "utf8"), /missing-tool/);
});

test("evidence is capped so a chatty cli can't flood the proposal", () => {
  const scratch = tempDir("tif-scratch-");
  const app = tempDir("tif-app-");
  put(app, "loud.cjs", `process.stdout.write("x".repeat(50000));`);
  const env = cliEnv({ cli: `node "{app}/loud.cjs"`, appDir: app, root: app, evidence: join(scratch, "e.txt") });
  const [node, shimPath] = JSON.parse(env.THISISFINE_CLI!) as string[];
  const r = spawnSync(node!, [shimPath!], { encoding: "utf8", env: { ...process.env, ...env, THISISFINE_WORK: join(scratch, "work") } });
  assert.equal(r.stdout.length, 50000, "the check still sees everything");
  const evidence = readFileSync(join(scratch, "e.txt"), "utf8");
  assert.ok(evidence.length < 2600, `evidence is ${evidence.length} chars`);
  assert.match(evidence, /… \(\d+ more bytes\)/);
});
