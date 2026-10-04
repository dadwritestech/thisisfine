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
