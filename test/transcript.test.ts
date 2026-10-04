import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyWords } from "../src/transcript.ts";
import { tempDir } from "./helpers.ts";

function transcript(entries: unknown[]): string {
  const path = join(tempDir(), "t.jsonl");
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n{not json\n");
  return path;
}

const human = (promptId: string, content: unknown) => ({
  type: "user", promptId, origin: { kind: "human" }, message: { role: "user", content }
});

test("a human prompt with the same id and words verifies", () => {
  const path = transcript([{ type: "assistant", message: { content: [] } }, human("pr1", "  y, perfect ")]);
  assert.equal(verifyWords(path, "pr1", "y, perfect"), "verified");
});

test("array content is joined text", () => {
  const path = transcript([human("pr1", [{ type: "text", text: "yes lock it" }])]);
  assert.equal(verifyWords(path, "pr1", "yes lock it"), "verified");
});

test("a tool result or other non-human entry with that id is not a human yes", () => {
  const path = transcript([{ type: "user", promptId: "pr1", message: { role: "user", content: "y" } }]);
  assert.equal(verifyWords(path, "pr1", "y"), "not-human");
});

test("different words under the same id are not found", () => {
  const path = transcript([human("pr1", "no wait")]);
  assert.equal(verifyWords(path, "pr1", "y"), "not-found");
  assert.equal(verifyWords(path, "pr9", "no wait"), "not-found");
});

test("a deleted transcript is reported as missing, not as forged", () => {
  assert.equal(verifyWords(join(tempDir(), "gone.jsonl"), "pr1", "y"), "missing");
  assert.equal(verifyWords("", "pr1", "y"), "missing");
});
