import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULTS, detectConfig, loadConfig, writeScaffold } from "../src/config.ts";
import { put, tempDir } from "./helpers.ts";

function project(pkg: object): string {
  const root = tempDir();
  put(root, "package.json", JSON.stringify(pkg));
  return root;
}

test("detects Next, Vite, dev and start scripts", () => {
  assert.equal(detectConfig(project({ dependencies: { next: "15" }, scripts: { dev: "next dev" } })).config.start, "npx next dev -p {port}");
  assert.equal(detectConfig(project({ devDependencies: { vite: "6" } })).config.start, "npx vite --port {port} --strictPort");
  assert.equal(detectConfig(project({ scripts: { dev: "node server.js", start: "node prod.js" } })).config.start, "npm run dev");
  assert.equal(detectConfig(project({ scripts: { start: "node server.js" } })).config.start, "npm start");
  const none = detectConfig(tempDir());
  assert.equal(none.config.start, "npm start");
  assert.match(none.detected, /set "start" or "cli"/);
  assert.equal(none.known, false);
  assert.equal(detectConfig(project({ scripts: { start: "node server.js" } })).known, true);
});

test("writeScaffold creates the committed files and pins Playwright", () => {
  const root = project({ scripts: { start: "node server.js" } });
  const { config } = detectConfig(root);
  writeScaffold(root, config);
  const dir = join(root, ".thisisfine");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).start, "npm start");
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).devDependencies["@playwright/test"], "1.61.0");
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^runs\/\nnode_modules\/\n/, "state lives in the home dir, not here");
  assert.match(readFileSync(join(dir, "playwright.config.mjs"), "utf8"), /THISISFINE_BASE_URL/);
  assert.ok(existsSync(join(dir, "checks")));
});

test("writeScaffold never overwrites an existing config", () => {
  const root = project({ scripts: { start: "node server.js" } });
  put(root, ".thisisfine/config.json", JSON.stringify({ start: "custom {port}" }));
  writeScaffold(root, detectConfig(root).config);
  assert.equal(loadConfig(root).start, "custom {port}");
});

test("loadConfig fills defaults and explains a missing config", () => {
  const root = tempDir();
  put(root, ".thisisfine/config.json", JSON.stringify({ start: "node app.js" }));
  const c = loadConfig(root);
  assert.equal(c.readyPath, "/");
  assert.equal(c.readyTimeoutMs, 60000);
  assert.throws(() => loadConfig(tempDir()), /thisisfine init/);
  put(root, ".thisisfine/config.json", JSON.stringify({ start: 42 }));
  assert.throws(() => loadConfig(root), /start/);
});

/** Evaluates the generated Playwright config with `defineConfig` as the identity, under `env`. */
async function generatedConfig(env: Record<string, string>): Promise<Record<string, any>> {
  const dir = tempDir();
  writeScaffold(dir, { start: "npm start", ...DEFAULTS });
  const source = readFileSync(join(dir, ".thisisfine", "playwright.config.mjs"), "utf8")
    .replace(`import { defineConfig } from "@playwright/test";`, "const defineConfig = (c) => c;")
    .replace("const env = process.env;", `const env = ${JSON.stringify(env)};`);
  const file = join(dir, "evaluated.mjs");
  writeFileSync(file, source);
  return (await import(pathToFileURL(file).href)).default;
}

test("the generated config gives each recorded check its own project behind its own proxy", async () => {
  const plain = await generatedConfig({});
  assert.equal(plain.projects, undefined, "proofs and unrecorded runs are unchanged");

  const cfg = await generatedConfig({ THISISFINE_PROXIES: JSON.stringify({ ".thisisfine/checks/1-badge.spec.ts": 5001, ".thisisfine/checks/sub/2-logo.spec.ts": 5002 }) });
  assert.equal(cfg.projects.length, 2);
  const [one, two] = cfg.projects;
  assert.deepEqual(one.use, { proxy: { server: "http://127.0.0.1:5001" } });
  assert.deepEqual(two.use, { proxy: { server: "http://127.0.0.1:5002" } });
  assert.equal(one.testMatch.test("C:\\p\\.thisisfine\\checks\\1-badge.spec.ts"), true);
  assert.equal(one.testMatch.test("/p/.thisisfine/checks/1-badge.spec.ts"), true);
  assert.equal(one.testMatch.test("/p/.thisisfine/checks/11-badge.spec.ts"), false);
  assert.equal(one.testMatch.test("/p/.thisisfine/checks/1-badgeXspec.ts"), false);
  assert.equal(two.testMatch.test("/p/.thisisfine/checks/sub/2-logo.spec.ts"), true);
});

test("detects Go and Python edges, and a package bin", () => {
  const goCli = tempDir();
  put(goCli, "go.mod", "module example.com/tool\n\ngo 1.22\n");
  put(goCli, "cmd/tool/main.go", "package main\nfunc main() {}\n");
  const g = detectConfig(goCli).config;
  assert.equal(g.build, "go build -o .thisisfine/bin/tool{exe} ./cmd/tool");
  assert.equal(g.cli, "{app}/.thisisfine/bin/tool{exe}");
  assert.equal(g.start, undefined);
  const goRoot = tempDir();
  put(goRoot, "go.mod", "module github.com/me/hello\n");
  put(goRoot, "main.go", "package main\n");
  assert.equal(detectConfig(goRoot).config.build, "go build -o .thisisfine/bin/hello{exe} .");

  const flask = tempDir();
  put(flask, "requirements.txt", "Flask==3.0\n");
  assert.equal(detectConfig(flask).config.start, "python -m flask run --port {port}");
  const django = tempDir();
  put(django, "manage.py", "");
  assert.match(detectConfig(django).config.start!, /runserver 127\.0\.0\.1:\{port\}/);
  const script = tempDir();
  put(script, "pyproject.toml", `[project]\nname = "csvkit2"\n\n[project.scripts]\ncsvtool = "csvkit2.cli:main"\n`);
  assert.equal(detectConfig(script).config.cli, "csvtool");

  assert.equal(detectConfig(project({ bin: { mytool: "bin/cli.js" } })).config.cli, "node bin/cli.js");
  assert.equal(detectConfig(project({ dependencies: { next: "15" } })).config.cli, undefined);
});

test("loadConfig: start or cli, and both must be commands", () => {
  const root = tempDir();
  put(root, ".thisisfine/config.json", JSON.stringify({ cli: "node tool.js" }));
  assert.equal(loadConfig(root).start, undefined);
  put(root, ".thisisfine/config.json", JSON.stringify({ build: "make" }));
  assert.throws(() => loadConfig(root), /"start".*"cli"/);
  put(root, ".thisisfine/config.json", JSON.stringify({ cli: "node 'tool.js" }));
  assert.throws(() => loadConfig(root), /unclosed quote/);
  put(root, ".thisisfine/config.json", JSON.stringify({ start: "x", build: "" }));
  assert.throws(() => loadConfig(root), /"build"/);
});

test("writeScaffold writes each language's kit only when the project uses it", () => {
  const py = tempDir();
  put(py, "pyproject.toml", "[project]\nname='x'\n");
  writeScaffold(py, detectConfig(py).config);
  const d = join(py, ".thisisfine");
  assert.ok(existsSync(join(d, "tif.ts")));
  assert.match(readFileSync(join(d, "thisisfine_check.py"), "utf8"), /def run\(/);
  assert.match(readFileSync(join(d, "pytest.ini"), "utf8"), /python_files = \*\.py/);
  assert.match(readFileSync(join(d, "requirements.txt"), "utf8"), /^pytest==/m);
  assert.ok(!existsSync(join(d, "go.mod")));
  assert.match(readFileSync(join(d, ".gitignore"), "utf8"), /^\.venv\/$/m);

  const go = tempDir();
  put(go, "go.mod", "module example.com/x\n");
  writeScaffold(go, { cli: "x", ...DEFAULTS });
  assert.match(readFileSync(join(go, ".thisisfine", "go.mod"), "utf8"), /^module thisisfine\.local\/checks$/m);
  assert.doesNotMatch(readFileSync(join(go, ".thisisfine", "go.mod"), "utf8"), /^\s*(replace|require)\b/m);
  assert.match(readFileSync(join(go, ".thisisfine", "tif", "tif.go"), "utf8"), /^package tif$/m);
  assert.ok(!existsSync(join(go, ".thisisfine", "pytest.ini")));
});
