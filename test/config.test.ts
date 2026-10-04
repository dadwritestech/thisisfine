import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectConfig, loadConfig, writeScaffold } from "../src/config.ts";
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
  assert.match(none.detected, /edit/i);
});

test("writeScaffold creates the committed files and pins Playwright", () => {
  const root = project({ scripts: { start: "node server.js" } });
  const { config } = detectConfig(root);
  writeScaffold(root, config);
  const dir = join(root, ".thisisfine");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).start, "npm start");
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).devDependencies["@playwright/test"], "1.61.0");
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "runs/\nnode_modules/\n", "state lives in the home dir, not here");
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
