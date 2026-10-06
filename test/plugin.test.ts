import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../src/cli.ts";

const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const frontmatter = (path: string) => /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path, "utf8").replace(/\r\n/g, "\n"))?.[1] ?? "";

test("every hook calls a real CLI subcommand through the plugin root", () => {
  const hooks = json("hooks/hooks.json").hooks as Record<string, { hooks: { command: string; timeout?: number }[] }[]>;
  assert.deepEqual(Object.keys(hooks).sort(), ["PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  for (const [event, groups] of Object.entries(hooks)) {
    for (const h of groups.flatMap((g) => g.hooks)) {
      const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/thisisfine\.mjs" (\S+)$/.exec(h.command);
      assert.ok(m, `${event}: ${h.command}`);
      assert.ok(COMMANDS.includes(m[1]!), `${event}: ${m[1]} is not a CLI command`);
      assert.ok(existsSync("bin/thisisfine.mjs"));
    }
  }
  assert.ok((hooks.Stop![0]!.hooks[0]!.timeout ?? 0) >= 300, "the stop hook boots an app and a browser");
});

test("the guard sees every tool that can read or write files", () => {
  const matcher = json("hooks/hooks.json").hooks.PreToolUse[0].matcher as string;
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Read", "Grep", "Glob"]) {
    assert.ok(matcher.split("|").includes(tool), tool);
  }
});

test("versions agree across package.json, plugin.json, and marketplace.json", () => {
  const v = json("package.json").version;
  assert.equal(json(".claude-plugin/plugin.json").version, v);
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].version, v);
  assert.equal(json(".claude-plugin/plugin.json").name, "thisisfine");
});

test("commands and the skill have the frontmatter Claude Code needs", () => {
  for (const f of readdirSync("commands")) {
    assert.match(frontmatter(join("commands", f)), /^description: \S/m, f);
  }
  const skill = frontmatter("skills/writing-promises/SKILL.md");
  assert.match(skill, /^name: writing-promises$/m);
  assert.match(skill, /^description: Use when /m);
});

test("the npm package ships everything the plugin needs", () => {
  const files = json("package.json").files as string[];
  for (const f of ["bin", "dist", "hooks", "commands", "skills", ".claude-plugin"]) assert.ok(files.includes(f), f);
});

test("the GitHub Action installs Playwright into .thisisfine/, gates on check, and diffs with the same report", () => {
  const action = readFileSync("action.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(action, /^runs:\n  using: composite$/m);
  const calls = [...action.matchAll(/node "\$TIF" (\S+)/g)].map((m) => m[1]!);
  assert.ok(calls.length >= 2);
  for (const c of calls) assert.ok(COMMANDS.includes(c), `${c} is not a CLI command`);
  assert.match(action, /TIF: \$\{\{ github\.action_path \}\}\/bin\/thisisfine\.mjs/);
  assert.match(action, /working-directory: \$\{\{ inputs\.working-directory \}\}\/\.thisisfine\n\s+run: \|\n\s+npm install/);
  assert.match(action, /install --with-deps chromium/);
  assert.match(action, /node "\$TIF" check --report "\$REPORT"/);
  assert.match(action, /node "\$TIF" diff "\$BASE" --report "\$REPORT" --markdown/);
  // the verdict comes last and looks at both
  const verdict = action.slice(action.lastIndexOf("- name:"));
  assert.match(verdict, /steps\.check\.outputs\.code/);
  assert.match(verdict, /steps\.diff\.outputs\.code/);
  assert.match(verdict, /exit 1/);
});
