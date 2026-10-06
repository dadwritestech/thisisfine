import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { traceErrors, zipEntries } from "../src/trace.ts";

// A real Playwright 1.61 trace (`--trace retain-on-failure`) of a check that
// clicks a button whose handler throws. The page also loads a script with a
// SyntaxError, which the trace records without a location.
const TRACE = join(import.meta.dirname, "fixtures", "click-error.trace.zip");

test("zipEntries reads a Playwright trace without any zip library", () => {
  const names = [...zipEntries(TRACE).keys()];
  assert.ok(names.includes("0-trace.trace"), names.join(", "));
  assert.match(zipEntries(TRACE).get("0-trace.trace")!.toString("utf8"), /"method":"pageError"/);
});

test("traceErrors lists what the page threw, with file:line when the trace has it", () => {
  assert.deepEqual(traceErrors(TRACE), [
    "SyntaxError: Unexpected token ';'",
    "TypeError: Cannot read properties of undefined (reading 'length') (/app.js:3:60)"
  ]);
});

test("traceErrors never throws: a missing or broken trace reads as no errors", () => {
  assert.deepEqual(traceErrors(join(import.meta.dirname, "fixtures", "nope.zip")), []);
  assert.deepEqual(traceErrors(join(import.meta.dirname, "trace.test.ts")), []);
});
