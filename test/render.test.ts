import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenForAgent, brokenForHuman, diffText, fineMessage, proofLine, sideEffectWarning, proposalLine, shortDate, statusText } from "../src/render.ts";
import { foldPromises } from "../src/promises.ts";
import type { BehaviourDiff } from "../src/diff.ts";
import type { Proof } from "../src/types.ts";
import { lock, proposal, retire } from "./helpers.ts";

const proven: Proof = {
  proven: true, reason: "fails on HEAD~1 while the app still boots", now: { screenshot: null },
  without: { method: "base", ref: "HEAD~1", note: null, booted: true, failed: true, message: "expected 3", screenshot: null }
};
const unproven: Proof = {
  proven: false, reason: "also passes on HEAD~1, so the behaviour predates it", now: { screenshot: null },
  without: { method: "base", ref: "HEAD~1", note: null, booted: true, failed: false, message: "", screenshot: null }
};

test("shortDate is month + day", () => {
  assert.equal(shortDate("2026-10-03T12:00:00.000Z"), "Oct 3");
});

test("proof lines say what was seen", () => {
  assert.equal(proofLine(proven), "✔ passes now ✔ fails on HEAD~1 (app still boots)");
  assert.match(proofLine(unproven), /🟡 unproven: also passes on HEAD~1/);
  assert.match(proofLine({ ...proven, without: { ...proven.without, method: "sabotage", ref: null, note: "badge hidden" } }), /fails when sabotaged \(badge hidden\)/);
  assert.match(proofLine(null), /🟡 unproven/);
});

test("proposal line asks for y with number, sentence, proof", () => {
  const line = proposalLine(proposal({ number: 14, proof: proven }), "");
  assert.equal(line, 'Lock in promise #14 "Badge shows the cart count"? ✔ passes now ✔ fails on HEAD~1 (app still boots)');
  assert.match(proposalLine(proposal({ action: "retire", reason: "redesign" }), "Badge shows the cart count"), /^Retire promise #1 "Badge shows the cart count"\? Reason: redesign/);
});

test("broken text quotes the human, the date, the failure and the screenshot", () => {
  const p = foldPromises([proposal(), lock({ words: "y, perfect", confirmedAt: "2026-10-03T12:00:00.000Z" })]).get(1)!;
  const outcome = { check: p.check, status: "failed" as const, message: "Expected: \"3\"\nReceived: \"0\"", screenshot: ".thisisfine/runs/x/shot.png" };
  const agent = brokenForAgent([{ promise: p, outcome }]);
  assert.match(agent, /🔥 This is NOT fine\. You broke promise #1 "Badge shows the cart count"/);
  assert.match(agent, /on Oct 3: "y, perfect"/);
  assert.match(agent, /Received: "0"/);
  assert.match(agent, /shot\.png/);
  assert.match(agent, /retire/);
  assert.match(brokenForHuman([{ promise: p, outcome }]), /#1 "Badge shows the cart count"/);
});

test("a page that throws on load says so before the assertion, so the long call log can't push it out", () => {
  const p = foldPromises([proposal(), lock()]).get(1)!;
  const callLog = Array.from({ length: 40 }, (_, i) => `  - call log line ${i}`).join("\n");
  const outcome = { check: p.check, status: "failed" as const, message: `Expected: "dark"\nReceived: "light"\n${callLog}`, screenshot: null,
    pageErrors: ["SyntaxError: Invalid left-hand side in assignment (http://127.0.0.1:5000/web/js/ui.js:89)"] };
  const agent = brokenForAgent([{ promise: p, outcome }]);
  assert.match(agent, /The page threw while loading:\n +SyntaxError: Invalid left-hand side in assignment \(.*ui\.js:89\)/);
  assert.ok(agent.indexOf("SyntaxError") < agent.indexOf("Received"), "page error first");
  assert.doesNotMatch(brokenForAgent([{ promise: p, outcome: { ...outcome, pageErrors: [] } }]), /page threw/);
});

test("errors thrown while the check ran come after load errors and before the assertion, capped", () => {
  const p = foldPromises([proposal(), lock()]).get(1)!;
  const outcome = { check: p.check, status: "failed" as const, message: `Expected: "2"\nReceived: "0"`, screenshot: null,
    pageErrors: ["SyntaxError: Unexpected token ')' (/vendor.js:4:2)"],
    checkErrors: Array.from({ length: 8 }, (_, i) => `TypeError: boom ${i} (/app.js:${i + 1}:5)`) };
  const agent = brokenForAgent([{ promise: p, outcome }]);
  assert.match(agent, /The page threw while loading:\n +SyntaxError[^\n]*\n +The page threw during the check:\n +TypeError: boom 0 \(\/app\.js:1:5\)/);
  assert.ok(agent.indexOf("during the check") < agent.indexOf("Received"), "before the assertion");
  assert.match(agent, /boom 4/);
  assert.doesNotMatch(agent, /boom 5/);
  assert.match(agent, /\(and 3 more\)/);
  const onlyDuring = brokenForAgent([{ promise: p, outcome: { ...outcome, pageErrors: [], checkErrors: ["TypeError: boom (/app.js:3:60)"] } }]);
  assert.doesNotMatch(onlyDuring, /while loading|more\)/);
  assert.match(onlyDuring, /The page threw during the check:\n +TypeError: boom/);
});

test("fine message counts kept promises and flags flaky ones", () => {
  assert.equal(fineMessage(14, []), "☕ This is fine. 14/14 promises kept.");
  assert.equal(fineMessage(3, [2]), "☕ This is fine. 3/3 promises kept (#2 was flaky: passed on retry).");
});

test("a partial run says how many it checked and why the rest were skipped", () => {
  assert.equal(fineMessage(1, [], { of: 3, why: "only public/about.html changed" }),
    "☕ This is fine. 1/1 promise this change can affect kept (2 others skipped: only public/about.html changed).");
  assert.equal(fineMessage(2, [4], { of: 5, why: "only a.css changed" }),
    "☕ This is fine. 2/2 promises this change can affect kept (3 others skipped: only a.css changed) (#4 was flaky: passed on retry).");
});

test("status text lists active, retired and pending", () => {
  const recs = [proposal({ proof: proven }), lock({ proof: proven }), proposal({ id: "p2", number: 2, sentence: "Empty cart disables checkout" }),
    lock({ proposal: "p2", number: 2, sentence: "Empty cart disables checkout", proof: unproven }),
    proposal({ id: "p3", action: "retire", number: 2, reason: "x" }), retire({ proposal: "p3", number: 2 }),
    proposal({ id: "p4", number: 3, sentence: "Logo links home" })];
  const text = statusText(recs);
  assert.match(text, /#1 +✅ proven +"Badge shows the cart count"\n +locked Oct 4 \("y"\)/);
  assert.match(text, /#2 +retired +"Empty cart disables checkout"\n +retired Oct 5/);
  assert.match(text, /pending #3 "Logo links home"/);
});

test("sideEffectWarning names the files the app wrote, and is silent when there are none", () => {
  assert.equal(sideEffectWarning([]), "");
  const w = sideEffectWarning(["config.json", "data/app.db"]);
  assert.match(w, /While the check ran, the app wrote to: config\.json, data\/app\.db/);
  assert.match(w, /every Stop/);
  assert.match(w, /scratch copy/);
});

function emptyDiff(): BehaviourDiff {
  return {
    locked: [], replaced: [], retired: [], pending: [], dropped: [], edited: [], broken: [], flaky: [], kept: [],
    notRun: null, newSigned: [], unverifiable: [], badSignatures: [], ok: true
  };
}

test("diff text: locks, replacements, retirements and pending, one line each", () => {
  const folded = foldPromises([proposal(), lock({ words: "y, perfect", confirmedAt: "2026-10-04T12:00:00.000Z", proof: proven })]);
  const p1 = folded.get(1)!;
  const p2 = { ...p1, number: 2, sentence: "Logged-out visitors go to /login", status: "retired" as const, retire: retire({ number: 2, reason: "login moved to SSO" }) };
  const text = diffText({
    ...emptyDiff(),
    locked: [p1],
    replaced: [{ before: { ...p1, number: 3, sentence: "Old words" }, after: { ...p1, number: 3, sentence: "New words" } }],
    retired: [p2],
    pending: [{ proposal: proposal({ number: 5, sentence: "Search finds a coffee" }), sentence: "Search finds a coffee" }]
  }, { base: "main", markdown: false });
  assert.match(text, /^\+ #1 locked: "Badge shows the cart count" ✅ proven \("y, perfect", Oct 4\)$/m);
  assert.match(text, /^~ #3 replaced: "Old words" → "New words"$/m);
  assert.match(text, /^- #2 retired: "Logged-out visitors go to \/login" \(login moved to SSO\)$/m);
  assert.match(text, /^\? #5 waiting for a human y: "Search finds a coffee"$/m);
  assert.match(text, /vs main/);
});

test("diff text: problems come first and say what broke", () => {
  const p = foldPromises([proposal(), lock()]).get(1)!;
  const text = diffText({
    ...emptyDiff(), ok: false,
    broken: [{ promise: p, outcome: { check: p.check, status: "failed", message: "Expected: \"2\"\nReceived: \"1\"", screenshot: null } }],
    edited: [p],
    dropped: [lock()],
    kept: [{ ...p, number: 4 }]
  }, { base: "main", markdown: false });
  const lines = text.split("\n");
  const firstProblem = lines.findIndex((l) => l.startsWith("✗"));
  assert.ok(firstProblem > 0 && firstProblem < lines.findIndex((l) => l.startsWith("✔")));
  assert.match(text, /^✗ #1 broken: "Badge shows the cart count"$/m);
  assert.match(text, /Received: "1"/);
  assert.match(text, /^✗ #1's check was changed after it was locked \(\.thisisfine\/checks\/1-badge\.spec\.ts\)$/m);
  assert.match(text, /^✗ 1 record from main is missing here \(#1 lock\)/m);
  assert.match(text, /append-only/);
  assert.match(text, /^✔ 1 promise kept \(#4\)$/m);
});

test("diff text for a PR: a short base, no call log, and no 'nothing changed' under a failure", () => {
  const p = foldPromises([proposal(), lock()]).get(1)!;
  const message = `Error: expect(locator).toHaveText(expected) failed\n\nExpected: "2"\nReceived: "1"\nTimeout: 5000ms\n\nCall log:\n  - waiting for getByTestId('badge')\n\n  12 |   await expect(page.getByTestId("badge")).toHaveText("2");`;
  const broken = [{ promise: p, outcome: { check: p.check, status: "failed" as const, message, screenshot: null } }];
  const text = diffText({ ...emptyDiff(), ok: false, broken }, { base: "8d2806249114065922ddc8ccc283ea967873be2e", markdown: true });
  assert.match(text, /\(vs 8d28062\)$/m);
  assert.match(text, /Received: "1"/);
  assert.doesNotMatch(text, /Call log|waiting for|12 \|/);
  assert.doesNotMatch(text, /No promises changed/);
  assert.match(diffText(emptyDiff(), { base: "origin/main", markdown: false }), /\(vs origin\/main\)/);
});

test("diff text: checks that didn't run, flaky ones, and a quiet branch", () => {
  const p = foldPromises([proposal(), lock()]).get(1)!;
  assert.match(diffText({ ...emptyDiff(), ok: false, notRun: "the app didn't start" }, { base: "main", markdown: false }), /^✗ The checks didn't run: the app didn't start$/m);
  assert.match(diffText({ ...emptyDiff(), flaky: [p] }, { base: "main", markdown: false }), /^! #1 flaky: passed on retry$/m);
  assert.match(diffText(emptyDiff(), { base: "main", markdown: false }), /No promises changed/);
});

test("diff text: signatures from keys that aren't committed are explained, not failed", () => {
  const text = diffText({ ...emptyDiff(), newSigned: [lock({ keyId: "abc123" })], unverifiable: [lock({ keyId: "abc123" })] }, { base: "main", markdown: false });
  assert.match(text, /1 new confirmation was signed with a key that isn't in \.thisisfine\/keys\/ \(key abc123\)/);
  assert.match(text, /thisisfine verify/);
  const bad = diffText({ ...emptyDiff(), ok: false, badSignatures: [lock()] }, { base: "main", markdown: false });
  assert.match(bad, /^✗ #1's lock: the signature doesn't match/m);
});

test("diff markdown: a heading, the lines in a diff fence (so + is green and - is red), the note outside", () => {
  const text = diffText({ ...emptyDiff(), newSigned: [lock()], unverifiable: [lock()] }, { base: "main", markdown: true });
  assert.match(text, /^### /);
  assert.match(text, /```diff\n[\s\S]*No promises changed[\s\S]*\n```/);
  assert.match(text.split("```").at(-1)!, /key that isn't in \.thisisfine\/keys\//);
});
