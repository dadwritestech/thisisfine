#!/usr/bin/env node
// thisisfine ships as TypeScript and runs on Node's built-in type stripping,
// so there is no build step and no dependency to install.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`thisisfine needs Node 22.18 or newer (this is ${process.versions.node}).\n`);
  process.exit(1);
}
const { runCli } = await import("../src/cli.ts");
process.exitCode = await runCli(process.argv.slice(2));
