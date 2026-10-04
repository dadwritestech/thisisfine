import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A git repo with a local identity and LF-only checkouts. */
export function initRepo(dir: string): string {
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.name", "test"]);
  sh(dir, "git", ["config", "user.email", "test@example.com"]);
  sh(dir, "git", ["config", "core.autocrlf", "false"]);
  return dir;
}

export function put(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

export function commitAll(root: string, msg: string): string {
  sh(root, "git", ["add", "-A"]);
  sh(root, "git", ["commit", "-q", "-m", msg]);
  return sh(root, "git", ["rev-parse", "HEAD"]);
}
