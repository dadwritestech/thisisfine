// Compiles src/*.ts to plain JS in dist/ for the npm package. Node won't strip
// types from files under node_modules, so `npx thisisfine` needs real JS.
// A git checkout (and so the Claude Code plugin) runs src/ directly and never needs this.
import { execFileSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });
// runner.ts spawns this helper from its own directory, so it must sit next to runner.js.
copyFileSync(join(root, "src", "page-probe.mjs"), join(dist, "page-probe.mjs"));
// boundary.ts hands checks this shim's path from its own directory, too.
copyFileSync(join(root, "src", "cli-shim.mjs"), join(dist, "cli-shim.mjs"));
