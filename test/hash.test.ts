import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileHash } from "../src/hash.ts";
import { tempDir } from "./helpers.ts";

test("CRLF and LF copies of a file hash the same", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "lf.ts"), "a\nb\n");
  writeFileSync(join(dir, "crlf.ts"), "a\r\nb\r\n");
  assert.equal(fileHash(join(dir, "lf.ts")), fileHash(join(dir, "crlf.ts")));
});

test("different content hashes differently; hash is 16 hex", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "a.ts"), "expect(1)");
  writeFileSync(join(dir, "b.ts"), "expect(2)");
  const a = fileHash(join(dir, "a.ts"));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, fileHash(join(dir, "b.ts")));
});

test("missing file hashes to the sentinel 'missing'", () => {
  assert.equal(fileHash(join(tempDir(), "nope.ts")), "missing");
});
