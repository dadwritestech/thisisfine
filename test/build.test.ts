import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DIST = resolve("dist");

test("the npm package ships dist/ and not src/", () => {
  // bin/thisisfine.mjs prefers src/ when it exists, and Node won't strip types
  // under node_modules, so shipping src/ would break `npx thisisfine`.
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[]; scripts: Record<string, string> };
  assert.ok(!pkg.files.includes("src"));
  assert.equal(pkg.scripts.prepack, "npm run build");
});

test("npm run build emits plain JS that runs without type stripping", () => {
  execFileSync(process.execPath, [resolve("scripts/build.mjs")], { stdio: "pipe" });
  const files = readdirSync(DIST);
  for (const ts of readdirSync("src").filter((f) => f.endsWith(".ts"))) {
    assert.ok(files.includes(ts.replace(/\.ts$/, ".js")), ts);
  }
  assert.ok(existsSync(join(DIST, "page-probe.mjs")), "runner.js spawns page-probe.mjs from its own directory");
  for (const f of files.filter((f) => f.endsWith(".js"))) {
    assert.doesNotMatch(readFileSync(join(DIST, f), "utf8"), /from "\.\.?\/[^"]*\.ts"/, f);
  }
  const help = execFileSync(process.execPath, [
    "--no-experimental-strip-types", "--input-type=module", "-e",
    `const { runCli } = await import(${JSON.stringify(pathToFileURL(join(DIST, "cli.js")).href)}); process.exitCode = await runCli(["--help"]);`,
  ], { encoding: "utf8" });
  assert.match(help, /hook-stop/);
});
