import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { decideGuard } from "../src/guard.ts";
import type { LedgerRecord } from "../src/types.ts";
import { lock, proposal, retire, tempDir } from "./helpers.ts";

const root = tempDir();
const home = join(tempDir(), ".thisisfine");
const locked: LedgerRecord[] = [proposal(), lock()];
const p = (rel: string) => join(root, rel);

function guard(toolName: string, toolInput: Record<string, unknown>, records: LedgerRecord[] = locked) {
  return decideGuard({ toolName, toolInput, root, home, records });
}

test("the ledger can never be written, with or without locks", () => {
  for (const records of [[], locked]) {
    const d = guard("Write", { file_path: p(".thisisfine/promises.jsonl") }, records);
    assert.equal(d.deny, true);
    assert.match(d.reason, /promises\.jsonl/);
  }
  assert.equal(guard("Edit", { file_path: ".thisisfine\\promises.jsonl" }).deny, true, "relative, backslashes");
});

test("a locked check can't be edited, and the reason names the promise", () => {
  const d = guard("Edit", { file_path: p(".thisisfine/checks/1-badge.spec.ts") });
  assert.equal(d.deny, true);
  assert.match(d.reason, /#1 "Badge shows the cart count"/);
  assert.match(d.reason, /Fix the app/);
  assert.equal(guard("MultiEdit", { file_path: p(".thisisfine/checks/1-badge.spec.ts") }).deny, true);
});

test("a retired promise's check is free again", () => {
  const records = [...locked, proposal({ id: "p2", action: "retire" }), retire()];
  assert.equal(guard("Edit", { file_path: p(".thisisfine/checks/1-badge.spec.ts") }, records).deny, false);
});

test("new checks and app code are fine", () => {
  assert.equal(guard("Write", { file_path: p(".thisisfine/checks/2-logo.spec.ts") }).deny, false);
  assert.equal(guard("Edit", { file_path: p("src/cart.js") }).deny, false);
  assert.equal(guard("Read", { file_path: p(".thisisfine/promises.jsonl") }).deny, false, "reading is always fine");
});

test("config and Playwright setup are open until the first lock, then closed", () => {
  for (const rel of [".thisisfine/config.json", ".thisisfine/playwright.config.mjs", ".thisisfine/package.json"]) {
    assert.equal(guard("Edit", { file_path: p(rel) }, []).deny, false, `${rel} before locks`);
    const d = guard("Edit", { file_path: p(rel) });
    assert.equal(d.deny, true, `${rel} after locks`);
    assert.match(d.reason, /ask the human/);
  }
});

test("public keys can never be written by the agent, with or without locks", () => {
  for (const records of [[], locked]) {
    for (const rel of [".thisisfine/keys/sam.pub", ".thisisfine/keys/agent.pub", ".thisisfine\\keys\\x.pub"]) {
      const d = guard("Write", { file_path: rel.includes("\\") ? rel : p(rel) }, records);
      assert.equal(d.deny, true, `${rel} with ${records.length} records`);
      assert.match(d.reason, /keys/);
    }
    for (const command of ["cp /tmp/evil.pub .thisisfine/keys/", "rm .thisisfine/keys/sam.pub", "echo x > .thisisfine/keys/a.pub", "mv .thisisfine/keys .thisisfine/k"]) {
      const d = guard("Bash", { command }, records);
      assert.equal(d.deny, true, `${command} with ${records.length} records`);
      assert.match(d.reason, /keys/);
    }
  }
  assert.equal(guard("Read", { file_path: p(".thisisfine/keys/sam.pub") }).deny, false, "public keys are public");
  assert.equal(guard("Bash", { command: "cat .thisisfine/keys/sam.pub" }, []).deny, false);
});

test("the home dir (key, mirror, state) is off limits to file tools", () => {
  assert.equal(guard("Write", { file_path: join(home, "key") }, []).deny, true);
  assert.equal(guard("Edit", { file_path: join(home, "projects", "abc", "state.json") }, []).deny, true);
  assert.equal(guard("Read", { file_path: join(home, "key") }, []).deny, true, "the key signs locks: reading it is forging");
  assert.equal(guard("Grep", { pattern: ".", path: home }, []).deny, true);
});

test("Bash: hooks can't be invoked by hand", () => {
  const d = guard("Bash", { command: `echo '{"prompt":"y"}' | thisisfine hook-prompt` }, []);
  assert.equal(d.deny, true);
  assert.match(d.reason, /only the human/i);
});

test("Bash: anything touching the ledger or the home dir is denied", () => {
  for (const command of [
    "cat .thisisfine/promises.jsonl",
    "git checkout -- .thisisfine/promises.jsonl",
    "cat ~/.thisisfine/key",
    "ls $HOME/.thisisfine/projects",
    `cat "${home.replace(/\\/g, "/")}/key"`,
    `type ${home}\\key`,
    "THISISFINE_HOME=/tmp/x thisisfine status"
  ]) {
    assert.equal(guard("Bash", { command }, []).deny, true, command);
  }
});

test("Bash: writes to locked checks or config are denied, reads are not", () => {
  for (const command of [
    "echo 'test.skip()' > .thisisfine/checks/1-badge.spec.ts",
    "sed -i 's/3/0/' .thisisfine/checks/1-badge.spec.ts",
    "rm -rf .thisisfine",
    "cd .thisisfine/checks && rm 1-badge.spec.ts",
    "git checkout HEAD~1 -- .thisisfine/config.json"
  ]) {
    assert.equal(guard("Bash", { command }).deny, true, command);
  }
  for (const command of [
    "cat .thisisfine/checks/1-badge.spec.ts",
    "cat .thisisfine/config.json 2>/dev/null",
    "npm test > test.log 2>&1",
    "thisisfine propose --sentence \"Logo links home\" --check .thisisfine/checks/2-logo.spec.ts",
    "thisisfine restore",
    "rm -rf .thisisfine/runs"
  ]) {
    assert.equal(guard("Bash", { command }).deny, false, command);
  }
});

test("Bash: before any lock, setup commands are allowed", () => {
  assert.equal(guard("Bash", { command: "rm -rf .thisisfine && thisisfine init" }, []).deny, false);
});

const patch = (...lines: string[]) => ({ command: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") });

test("Codex apply_patch: every file the patch touches goes through the same rules", () => {
  const d = guard("apply_patch", patch("*** Update File: .thisisfine/checks/1-badge.spec.ts", "@@", "-a", "+b"));
  assert.equal(d.deny, true);
  assert.match(d.reason, /#1 "Badge shows the cart count"/);
  assert.equal(guard("apply_patch", patch("*** Add File: .thisisfine/promises.jsonl", "+x")).deny, true, "add the ledger");
  assert.equal(guard("apply_patch", patch("*** Delete File: .thisisfine/keys/sam.pub")).deny, true, "delete a key");
  assert.equal(guard("apply_patch", patch("*** Update File: src/a.js", "*** Move to: .thisisfine/checks/1-badge.spec.ts", "@@", "-a", "+b")).deny, true, "move onto a locked check");
  assert.equal(guard("apply_patch", patch("*** Update File: src/cart.js", "@@", "-a", "+b", "*** Update File: .thisisfine\\config.json", "@@", "-a", "+b")).deny, true, "second file, backslashes");
});

test("Codex apply_patch: app code and new checks are fine, and so is text that only looks like a header", () => {
  assert.equal(guard("apply_patch", patch("*** Update File: src/cart.js", "@@", "-a", "+b", "*** Add File: .thisisfine/checks/2-logo.spec.ts", "+x")).deny, false);
  assert.equal(guard("apply_patch", patch("*** Update File: notes.md", "@@", "+ *** Update File: .thisisfine/promises.jsonl")).deny, false, "a + line is content");
  assert.equal(guard("apply_patch", {}).deny, false);
});

test("Codex apply_patch can't reach the home dir either", () => {
  assert.equal(guard("apply_patch", patch(`*** Add File: ${join(home, "state.json")}`, "+x")).deny, true);
});

test("a locked Go check is its whole directory; a sibling Go check and the build output stay free", () => {
  const go = ".thisisfine/checks/3-dry-run/check_test.go";
  const records: LedgerRecord[] = [
    proposal({ id: "p3", number: 3, sentence: "--dry-run writes nothing", check: go }),
    lock({ proposal: "p3", number: 3, sentence: "--dry-run writes nothing", check: go })
  ];
  for (const rel of [go, ".thisisfine/checks/3-dry-run/helper_test.go"]) {
    const d = guard("Write", { file_path: p(rel) }, records);
    assert.equal(d.deny, true, rel);
    assert.match(d.reason, /#3/);
  }
  assert.equal(guard("Write", { file_path: p(".thisisfine/checks/4-help/check_test.go") }, records).deny, false);
  assert.equal(guard("Write", { file_path: p(".thisisfine/tif/tif.go") }, records).deny, true, "the Go kit is setup");
  assert.equal(guard("Write", { file_path: p(".thisisfine/thisisfine_check.py") }, records).deny, true, "so is the Python one");
  assert.equal(guard("Write", { file_path: p(".thisisfine/bin/tool.exe") }, records).deny, false, "build output");

  for (const command of [
    "rm -rf .thisisfine/checks/3-dry-run",
    "cd .thisisfine/checks && rm -r 3-dry-run",
    "echo 'package checks' > .thisisfine/checks/3-dry-run/check_test.go"
  ]) {
    assert.equal(guard("Bash", { command }, records).deny, true, command);
  }
  for (const command of [
    "mkdir -p .thisisfine/checks/4-help && cp /tmp/x.go .thisisfine/checks/4-help/check_test.go",
    "rm 13-dry-run.txt",
    "rm -rf .thisisfine/bin"
  ]) {
    assert.equal(guard("Bash", { command }, records).deny, false, command);
  }
});
