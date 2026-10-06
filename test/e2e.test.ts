/**
 * The whole story, for real: a shop without a cart badge, Claude adding one,
 * a human saying "y, perfect", and a later "refactor" that quietly breaks it.
 * Real npm install, real Playwright, real browser, the real bin driven through
 * the same JSON Claude Code sends to hooks.
 *
 * Opt-in because it downloads Playwright and takes a minute or two:
 *   THISISFINE_E2E=1 npm run test:e2e
 * Set THISISFINE_E2E_OUT=<dir> to keep each step's output (the README quotes it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { commitAll, initRepo, put, tempDir } from "./helpers.ts";

const BIN = resolve("bin/thisisfine.mjs");
const OUT = process.env.THISISFINE_E2E_OUT;
const CHECK = ".thisisfine/checks/1-cart-badge.spec.ts";
const SENTENCE = "Adding a coffee twice shows 2 on the cart badge";

const CHECK_SOURCE = `import { test, expect } from "@playwright/test";

test("adding a coffee twice shows 2 on the cart badge", async ({ page }) => {
  await page.goto("/");
  const add = page.getByRole("button", { name: "Add House blend to cart" });
  await add.click();
  await add.click();
  await expect(page.getByTestId("cart-count")).toHaveText("2");
});
`;

test("a shop, a badge, a yes, a refactor: thisisfine catches it", { skip: process.env.THISISFINE_E2E !== "1", timeout: 600_000 }, () => {
  const root = tempDir("tif-e2e-");
  const home = join(tempDir("tif-home-"), "home");
  const transcript = join(root, "..", `${root.split(/[\\/]/).pop()}-transcript.jsonl`);
  if (OUT) mkdirSync(OUT, { recursive: true });

  function run(step: string, args: string[], stdin?: unknown) {
    const started = performance.now();
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd: root, encoding: "utf8", input: stdin === undefined ? "" : JSON.stringify(stdin),
      env: { ...process.env, THISISFINE_HOME: home }, timeout: 300_000
    });
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    if (OUT) writeFileSync(join(OUT, `${step}.txt`), `$ thisisfine ${args.join(" ")}\n[exit ${r.status}, ${secs}s]\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`);
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout || "{}") as Record<string, any> };
  }
  const hook = (step: string, name: string, extra: Record<string, unknown> = {}) =>
    run(step, [name], { session_id: "s1", transcript_path: transcript, cwd: root, hook_event_name: name, ...extra });
  /** Keep a screenshot the output points at (the temp project is deleted afterwards). */
  const keep = (text: string, name: string) => {
    const shot = /\.thisisfine\/runs\/\S+?\.png/.exec(text)?.[0];
    assert.ok(shot, `${name}: no screenshot in output`);
    assert.ok(existsSync(join(root, shot)), shot);
    if (OUT) copyFileSync(join(root, shot), join(OUT, name));
  };
  const edit = (rel: string, from: string, to: string) => {
    const path = join(root, rel);
    const before = readFileSync(path, "utf8");
    assert.ok(before.includes(from), `${rel} should contain ${from}`);
    writeFileSync(path, before.replace(from, to));
  };

  // 1. The shop as it ships: no badge.
  cpSync(resolve("examples/cart"), root, { recursive: true });
  initRepo(root);
  const v1 = commitAll(root, "Fine Coffee Co. v1");

  // 2. init: scaffold + real Playwright install.
  const init = run("01-init", ["init"]);
  assert.equal(init.code, 0, init.stderr);
  assert.match(init.stdout, /"start" script/);
  assert.ok(existsSync(join(root, ".thisisfine/node_modules/@playwright/test")), "playwright installed");
  commitAll(root, "thisisfine init");

  // 3. "Claude, add a cart badge."
  edit("public/index.html", `<a id="cart-link" href="#cart">Cart</a>`, `<a id="cart-link" href="#cart">Cart<span data-testid="cart-count">0</span></a>`);
  edit("public/app.js", `cart.push(button.closest("[data-product]").dataset.product);`,
    `cart.push(button.closest("[data-product]").dataset.product);\n    document.querySelector("[data-testid=cart-count]").textContent = String(cart.length);`);

  // 4. Claude writes the check and proposes it. The badge is uncommitted, so HEAD is "without".
  put(root, CHECK, CHECK_SOURCE);
  const propose = run("02-propose", ["propose", "--sentence", SENTENCE, "--check", CHECK]);
  assert.equal(propose.code, 0, propose.stdout + propose.stderr);
  assert.match(propose.stdout, /✔ passes now ✔ fails on HEAD \(app still boots\)/);
  assert.match(propose.stdout, /Ask the human exactly this/);
  assert.doesNotMatch(propose.stdout, /the app wrote to/, "the cart app keeps everything in the browser");
  keep(propose.stdout, "badge-works.png");

  // 5. The human answers. Claude Code writes the prompt to the transcript, then fires the hook.
  const words = "y, perfect";
  writeFileSync(transcript, JSON.stringify({ type: "user", promptId: "pr-yes", origin: { kind: "human" }, message: { role: "user", content: words } }) + "\n");
  const yes = hook("03-hook-prompt-yes", "hook-prompt", { prompt: words, prompt_id: "pr-yes" });
  assert.equal(yes.code, 0, yes.stderr);
  assert.match(yes.stdout, /locked/i);
  commitAll(root, "cart badge + promise #1");

  // 6. End of turn: the promise holds.
  const fine = hook("04-hook-stop-fine", "hook-stop");
  assert.equal(fine.code, 0, fine.stderr);
  assert.notEqual(fine.json().decision, "block", fine.stdout);
  assert.match(fine.stdout, /This is fine/);

  // 7. The check is now out of the agent's reach.
  const guarded = hook("05-hook-guard-edit-check", "hook-guard", { tool_name: "Edit", tool_input: { file_path: join(root, CHECK), old_string: "2", new_string: "1" } });
  assert.equal(guarded.json().hookSpecificOutput?.permissionDecision, "deny", guarded.stdout);

  // 8. Weeks later: "tidy up the cart code". Distinct products instead of items.
  edit("public/app.js", "String(cart.length)", "String(new Set(cart).size)");
  const broken = hook("06-hook-stop-broken", "hook-stop");
  assert.equal(broken.code, 0, broken.stderr);
  const b = broken.json();
  assert.equal(b.decision, "block", broken.stdout);
  assert.match(b.reason, /#1/);
  assert.ok(b.reason.includes(words), "quotes the human's own words");
  assert.match(b.reason, /Expected[\s\S]*"2"[\s\S]*Received[\s\S]*"1"/);
  assert.doesNotMatch(b.reason, /page threw/, "a wrong number is not a crash");
  keep(b.reason, "badge-broken.png");

  // 8a. The same break in CI: a runner with no key and no mirror, as the GitHub Action runs it.
  const ciHome = join(tempDir("tif-ci-"), "home");
  const report = join(ciHome, "..", "report.json");
  const ci = (step: string, args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, THISISFINE_HOME: ciHome }, timeout: 300_000 });
    if (OUT) writeFileSync(join(OUT, `${step}.txt`), `$ thisisfine ${args.join(" ")}\n[exit ${r.status}]\n${r.stdout}${r.stderr}`);
    return r;
  };
  const ciCheck = ci("06a-ci-check", ["check", "--report", report]);
  assert.equal(ciCheck.status, 1, ciCheck.stdout + ciCheck.stderr);
  const ciReport = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(ciReport.ran, true, "a lock signed elsewhere still runs in CI");
  assert.equal(ciReport.outcomes[0].status, "failed");
  const ciDiff = ci("06a-ci-diff", ["diff", v1, "--report", report, "--markdown"]);
  assert.equal(ciDiff.status, 1, ciDiff.stdout + ciDiff.stderr);
  assert.match(ciDiff.stdout, /^✗ #1 broken: "Adding a coffee twice shows 2 on the cart badge"$/m);
  assert.match(ciDiff.stdout, /^\+ #1 locked: /m);
  assert.doesNotMatch(ciDiff.stdout, /Signatures not verified/, "the public key lives in the repo, so CI checks the signature");

  // 8b. A typo that kills the whole script: the gate names the error and the line, not just "Received: 0".
  edit("public/app.js", "String(new Set(cart).size)", "String(new Set(cart).size");
  const crashed = hook("06b-hook-stop-crashed", "hook-stop");
  assert.equal(crashed.json().decision, "block", crashed.stdout);
  assert.match(crashed.json().reason, /The page threw while loading:\n +SyntaxError[^\n]*app\.js:\d+/, crashed.stdout);
  assert.doesNotMatch(crashed.json().reason, /during the check/, "the check's own trace saw the same SyntaxError: said once");
  edit("public/app.js", "String(new Set(cart).size", "String(new Set(cart).size)");

  // 8c. The page loads fine but the click handler throws: the gate names that error, file and line, from the check's own run.
  edit("public/app.js", "String(new Set(cart).size)", "String(cart.count.toFixed())");
  const thrown = hook("06c-hook-stop-click-throws", "hook-stop");
  assert.equal(thrown.json().decision, "block", thrown.stdout);
  assert.match(thrown.json().reason, /The page threw during the check:\n +TypeError: Cannot read properties of undefined \(reading 'toFixed'\) \(\/app\.js:\d+:\d+\)/, thrown.stdout);
  assert.doesNotMatch(thrown.json().reason, /while loading/, "nothing threw on load");
  edit("public/app.js", "String(cart.count.toFixed())", "String(new Set(cart).size)");

  // 9. Claude fixes the app (not the check), and the turn can end.
  edit("public/app.js", "String(new Set(cart).size)", "String(cart.length)");
  const fixed = hook("07-hook-stop-fixed", "hook-stop");
  assert.notEqual(fixed.json().decision, "block", fixed.stdout);
  assert.match(fixed.stdout, /This is fine/);

  // 10. Anyone can audit the lock against the transcript.
  const status = run("08-status", ["status"]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /#1/);
  const verify = run("09-verify", ["verify"]);
  assert.equal(verify.code, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /the transcript shows a human typing those words/);
});
