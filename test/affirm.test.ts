import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPrompt, isAffirmative, isApproval } from "../src/affirm.ts";

test("short, whole-prompt yeses are affirmative", () => {
  for (const p of ["y", "Y", "yes", "Yes!", "yep", "ok", "OK.", "okay", "sure", "lock it", "lock it in", "Yes, lock it.",
    "do it", "go ahead", "yes please", "👍", "✅", " y \n", "ja", "haan", "avunu"]) {
    assert.equal(isAffirmative(p), true, p);
  }
});

test("anything with conditions, questions, or negation is not", () => {
  for (const p of ["y?", "yes but change the colour", "no", "n", "not yet", "ok so what does it check?", "yes and also fix the footer",
    "", "it", "please", "lock it? not sure", "yes no", "don't"]) {
    assert.equal(isAffirmative(p), false, p);
  }
});

test("approval phrases are spotted in short messages only", () => {
  for (const p of ["works!", "Perfect", "lgtm", "that's right", "looks good", "nice, it works now", "nailed it 🎉", "exactly what I wanted"]) {
    assert.equal(isApproval(p), true, p);
  }
  for (const p of ["it doesn't work", "not working", "still broken but looks good otherwise", "perfect is the enemy of good, now let's refactor the whole auth module and migrate the database to postgres",
    "works?"]) {
    assert.equal(isApproval(p), false, p);
  }
});

test("classifyPrompt: machine and slash prompts are neutral", () => {
  assert.equal(classifyPrompt("<task-notification>done</task-notification>"), "machine");
  assert.equal(classifyPrompt("/promises"), "command");
  assert.equal(classifyPrompt("y"), "affirmative");
  assert.equal(classifyPrompt("perfect"), "approval");
  assert.equal(classifyPrompt("add a footer"), "other");
});
