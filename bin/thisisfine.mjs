#!/usr/bin/env node
// In a git checkout (how the Claude Code plugin is installed) this runs src/
// directly on Node's built-in type stripping: no build step, nothing to install.
// The npm package ships only the compiled dist/, because Node refuses to strip
// types from files under node_modules.
import { existsSync } from "node:fs";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`thisisfine needs Node 22.18 or newer (this is ${process.versions.node}).\n`);
  process.exit(1);
}
const source = new URL("../src/cli.ts", import.meta.url);
const built = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(source) && !existsSync(built)) {
  process.stderr.write("thisisfine: neither src/cli.ts nor dist/cli.js exists. Run \"npm run build\".\n");
  process.exit(1);
}
const { runCli } = await import(existsSync(source) ? source.href : built.href);
process.exitCode = await runCli(process.argv.slice(2));
