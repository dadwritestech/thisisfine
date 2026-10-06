import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenForAgent, brokenForHuman, fineMessage, proofLine, sideEffectWarning, proposalLine, shortDate, statusText } from "../src/render.ts";
import { foldPromises } from "../src/promises.ts";
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
