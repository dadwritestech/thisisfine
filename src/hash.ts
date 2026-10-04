import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Hash of a check file, as signed into a lock. CRLF is folded to LF first
 * (learned the hard way): a `core.autocrlf`
 * checkout rewrites bytes without changing meaning, and a signed hash that
 * broke on every Windows clone would teach users to ignore the gate.
 *
 * A missing file hashes to "missing" rather than throwing, so the gate can
 * say "promise #3's check was deleted" instead of crashing.
 */
export function fileHash(absPath: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(absPath);
  } catch {
    return "missing";
  }
  const normalised = bytes.toString("utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}
