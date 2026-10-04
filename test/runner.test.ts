import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseReport } from "../src/runner.ts";

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
