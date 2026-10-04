import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import type { LockRecord, ProposalRecord, RetireRecord } from "../src/types.ts";

/** A temp dir removed when the test file finishes. */
export function tempDir(prefix = "tif-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

export const proposal = (over: Partial<ProposalRecord> = {}): ProposalRecord => ({
  kind: "proposal", id: "p1", action: "lock", number: 1, sentence: "Badge shows the cart count",
  check: ".thisisfine/checks/1-badge.spec.ts", checkHash: "abcdabcdabcdabcd", proof: null, reason: "",
  proposedAt: "2026-10-04T10:00:00.000Z", ...over
});

/** A lock with a dummy signature; tests that care about signatures sign it themselves. */
export const lock = (over: Partial<LockRecord> = {}): LockRecord => ({
  kind: "lock", proposal: "p1", number: 1, sentence: "Badge shows the cart count",
  check: ".thisisfine/checks/1-badge.spec.ts", checkHash: "abcdabcdabcdabcd", proof: null,
  confirmedAt: "2026-10-04T10:02:00.000Z", words: "y", promptId: "pr1", sessionId: "s1",
  transcriptPath: "", keyId: "k", sig: "0".repeat(64), ...over
});

export const retire = (over: Partial<RetireRecord> = {}): RetireRecord => ({
  kind: "retire", proposal: "p2", number: 1, reason: "badge removed by design",
  retiredAt: "2026-10-05T10:00:00.000Z", words: "yes", promptId: "pr2", sessionId: "s1",
  transcriptPath: "", keyId: "k", sig: "0".repeat(64), ...over
});
