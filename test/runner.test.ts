import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseReport, playwrightArgs, withoutLoadErrors } from "../src/runner.ts";

const root = join("D:", "proj");
const result = (status: string, extra: object = {}) => ({ status, retry: 0, errors: [], attachments: [], ...extra });
const spec = (title: string, testStatus: string, results: object[]) => ({ title, ok: testStatus !== "unexpected", tests: [{ status: testStatus, results }] });

const report = {
  suites: [
    { title: "1-badge.spec.ts", file: "1-badge.spec.ts", specs: [spec("Badge shows the cart count", "expected", [result("passed")])], suites: [] },
    {
      title: "2-checkout.spec.ts", file: "2-checkout.spec.ts", specs: [],
      suites: [{
        title: "checkout", file: "2-checkout.spec.ts", suites: [],
        specs: [spec("Empty cart disables checkout", "unexpected", [
          result("failed", {
            error: { message: "\u001b[31mError: expect(locator).toBeDisabled()\u001b[39m\n\nReceived: enabled" },
            attachments: [{ name: "screenshot", contentType: "image/png", path: join(root, ".thisisfine", "runs", "r1", "artifacts", "shot.png") }]
          })
        ])]
      }]
    },
    { title: "3-logo.spec.ts", file: "3-logo.spec.ts", specs: [spec("Logo links home", "flaky", [result("failed"), result("passed")])], suites: [] },
    { title: "5-skipped.spec.ts", file: "5-skipped.spec.ts", specs: [spec("x", "skipped", [result("skipped")])], suites: [] }
  ],
  errors: [{ message: "Error: 4-broken.spec.ts: SyntaxError: Unexpected token" }]
};

test("parseReport maps every requested check to one outcome", () => {
  const checks = [1, 2, 3, 4, 5].map((n) => `.thisisfine/checks/${["", "1-badge", "2-checkout", "3-logo", "4-broken", "5-skipped"][n]}.spec.ts`);
  const out = parseReport(report, root, checks);
  assert.deepEqual(out.map((o) => o.status), ["passed", "failed", "flaky", "missing", "missing"]);
  assert.equal(out[1].message, "Error: expect(locator).toBeDisabled()\n\nReceived: enabled", "ANSI colour stripped");
  assert.equal(out[1].screenshot, ".thisisfine/runs/r1/artifacts/shot.png", "root-relative, forward slashes");
  assert.match(out[3].message, /SyntaxError/);
  assert.match(out[4].message, /skipped/);
});

test("a timeout reports the step that hung, not just that time ran out", () => {
  const bare = "\u001b[31mTest timeout of 30000ms exceeded.\u001b[39m";
  const step = "Error: locator.click: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Theme' })\n  - <div id=\"wizard\" class=\"wizard-overlay\">…</div> intercepts pointer events";
  const timedOut = {
    suites: [{ title: "1-theme.spec.ts", file: "1-theme.spec.ts", suites: [],
      specs: [spec("Theme survives a reload", "unexpected", [result("timedOut", { error: { message: bare }, errors: [{ message: bare }, { message: step }] })])] }]
  };
  const [out] = parseReport(timedOut, root, [".thisisfine/checks/1-theme.spec.ts"]);
  assert.equal(out!.status, "failed");
  assert.match(out!.message, /locator\.click/);
  assert.match(out!.message, /intercepts pointer events/);
  assert.equal(out!.message.match(/Test timeout/g)?.length, 1, "the bare timeout line is not repeated");
});

test("a failure shows the code around the failing line, so the agent knows which assertion it was", () => {
  const message = "Error: expect(locator).toHaveAttribute(expected) failed\n\nExpected: \"dark\"\nReceived: \"light\"";
  const snippet = "  18 |     await page.reload();\n> 20 |     await expect(html).toHaveAttribute(\"data-theme\", want);";
  // Playwright 1.61's real shape: `error` keeps the snippet in its own field, `errors[]` folds it into the message
  const error = { message, snippet };
  const errors = [{ message: `${message}\n\n${snippet}` }];
  const failed = { suites: [{ title: "2-theme.spec.ts", file: "2-theme.spec.ts", suites: [],
      specs: [spec("Theme survives a reload", "unexpected", [result("failed", { error, errors })])] }] };
  const [out] = parseReport(failed, root, [".thisisfine/checks/2-theme.spec.ts"]);
  assert.match(out!.message, /Received: "light"/);
  assert.match(out!.message, /await page\.reload\(\);\n> 20 \|/);
  assert.equal(out!.message.match(/> 20 \|/g)?.length, 1, "error and errors[0] are the same failure: shown once");
});

test("a failed check carries what the page threw during it, read from that run's trace", () => {
  const trace = join(import.meta.dirname, "fixtures", "click-error.trace.zip");
  const failed = { suites: [{ title: "1-cart.spec.ts", file: "1-cart.spec.ts", suites: [],
    specs: [spec("Badge counts clicks", "unexpected", [result("failed", {
      error: { message: "Expected: \"1\"\nReceived: \"0\"" },
      attachments: [{ name: "trace", contentType: "application/zip", path: trace }]
    })])] }] };
  const [out] = parseReport(failed, root, [".thisisfine/checks/1-cart.spec.ts"]);
  assert.ok(out!.checkErrors?.some((e) => e === "TypeError: Cannot read properties of undefined (reading 'length') (/app.js:3:60)"), String(out!.checkErrors));
  const [passed] = parseReport(report, root, [".thisisfine/checks/1-badge.spec.ts"]);
  assert.equal(passed!.checkErrors, undefined, "only failures are looked into");
});

test("Playwright keeps a trace of every failing check, whatever the project's config says", () => {
  const args = playwrightArgs("cli.js", [".thisisfine/checks/1-a.spec.ts"]);
  assert.deepEqual(args.slice(0, 3), ["cli.js", "test", "checks/1-a.spec.ts"]);
  assert.deepEqual(args.slice(args.indexOf("--trace"), args.indexOf("--trace") + 2), ["--trace", "retain-on-failure"]);
});

test("errors the load-time probe already named are not repeated as thrown during the check", () => {
  const load = ["SyntaxError: Unexpected token ';' (/bad.js:1:12)", "ReferenceError: x is not defined (/app.js:1:1)"];
  const during = ["SyntaxError: Unexpected token ';'", "ReferenceError: x is not defined (/app.js:1:1)",
    "ReferenceError: x is not defined (/app.js:9:1)", "TypeError: boom (/app.js:3:60)"];
  assert.deepEqual(withoutLoadErrors(during, load), ["ReferenceError: x is not defined (/app.js:9:1)", "TypeError: boom (/app.js:3:60)"]);
  assert.deepEqual(withoutLoadErrors(during, []), during);
});
