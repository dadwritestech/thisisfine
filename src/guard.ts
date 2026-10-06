import { isAbsolute, relative, resolve } from "node:path";
import { activePromises } from "./promises.ts";
import { guardText } from "./render.ts";
import type { LedgerRecord } from "./types.ts";
import { NESTED_AGENT_ENVS, STATE_DIR } from "./types.ts";

export interface GuardInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  root: string;
  /** thisisfine's home (key, mirror, state). */
  home: string;
  records: LedgerRecord[];
}

export interface GuardDecision {
  deny: boolean;
  reason: string;
}

/** Lowercase: Claude Code says "Edit", pi says "edit". */
const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);
const NESTED = new RegExp(String.raw`\b(${NESTED_AGENT_ENVS.join("|")})\b`);
const ALLOW: GuardDecision = { deny: false, reason: "" };
const deny = (reason: string): GuardDecision => ({ deny: true, reason });

const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
const slashes = (s: string) => s.replace(/\\/g, "/");

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Project-relative, forward slashes, case-folded on Windows; null if outside the project. */
function projectRel(root: string, path: string): string | null {
  const abs = resolve(root, path);
  if (!inside(resolve(root), abs)) return null;
  return fold(slashes(relative(resolve(root), abs)));
}

/** `2>&1` and `> /dev/null` are plumbing, not writes. */
function looksLikeWrite(command: string): boolean {
  const c = command.replace(/\d*>&\d/g, " ").replace(/\d*>>?\s*(\/dev\/null|nul)\b/gi, " ");
  return />/.test(c)
    || /\b(sed|perl)\s+(-\S+\s+)*-i/.test(c)
    || /(^|[\s;&|(])(rm|rmdir|mv|cp|tee|truncate|touch|unlink|ln|chmod|del|erase|move|copy|ren)\s/i.test(c)
    || /\bgit\s+(checkout|restore|rm|mv|apply|stash|reset|clean)\b/.test(c)
    || /\b(Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item)\b/i.test(c)
    || /\b(writeFile|appendFile|unlinkSync|rmSync|renameSync)/.test(c)
    || /\bopen\([^)]*['"][wa]/.test(c);
}

/**
 * PreToolUse: the polite first line of defence. It stops the obvious ways
 * of breaking a promise without fixing the app (edit the check, edit the
 * ledger, forge a "yes"), and explains why so the agent goes back to the
 * app. It is a heuristic and doesn't need to be perfect: anything it
 * misses is still caught by the integrity check at Stop.
 */
export function decideGuard(i: GuardInput): GuardDecision {
  const home = fold(slashes(resolve(i.home)));
  const hasLocks = i.records.some((r) => r.kind === "lock");
  const lockedChecks = new Map(activePromises(i.records).map((p) => [fold(p.check), p]));

  const tool = i.toolName.toLowerCase();

  if (tool === "bash") {
    const command = typeof i.toolInput.command === "string" ? i.toolInput.command : "";
    const norm = fold(slashes(command));
    if (/\bhook-(session|prompt|guard|stop)\b/.test(command)) return deny(guardText.hooks);
    if (norm.includes(home) || /(~|\$home|\$\{home\}|%userprofile%|\$env:userprofile)\/+\.thisisfine\b/i.test(norm) || /THISISFINE_HOME/.test(command)) {
      return deny(guardText.home);
    }
    if (/promises\.jsonl/i.test(command)) return deny(guardText.ledger);
    // unsetting these is how a nested `pi -p y` would pass for a person
    if (NESTED.test(command)) return deny(guardText.nested);
    if (!looksLikeWrite(command)) return ALLOW;
    // A committed public key vouches for every lock it signs: no agent writes, locks or not.
    if (/\.thisisfine\/keys(?![\w-])/.test(norm)) return deny(guardText.keys);
    if (!hasLocks) return ALLOW;

    for (const p of lockedChecks.values()) {
      const base = p.check.slice(p.check.lastIndexOf("/") + 1);
      if (norm.includes(fold(base))) return deny(guardText.check(p.number, p.sentence));
    }
    const mentions = norm.match(/\.thisisfine(?![\w-])[^\s'"`;&|<>)]*/g) ?? [];
    for (const m of mentions) {
      const rel = m.replace(/\/+$/, "");
      if (rel.startsWith(`${STATE_DIR}/runs`)) continue;
      if (/^\.thisisfine\/checks\/[^/]+$/.test(rel) && !lockedChecks.has(rel)) continue;
      return deny(guardText.stateDir);
    }
    return ALLOW;
  }

  if (tool === "apply_patch") {
    const text = typeof i.toolInput.command === "string" ? i.toolInput.command : "";
    for (const path of patchPaths(text)) {
      const d = decidePath(i, path, true, home, hasLocks, lockedChecks);
      if (d.deny) return d;
    }
    return ALLOW;
  }

  const raw = i.toolInput.file_path ?? i.toolInput.notebook_path ?? i.toolInput.path;
  if (typeof raw !== "string" || raw === "") return ALLOW;
  return decidePath(i, raw, WRITE_TOOLS.has(tool), home, hasLocks, lockedChecks);
}

/**
 * Codex edits files with one `apply_patch` tool whose input is the patch
 * itself. The paths are in its header lines; body lines start with a space,
 * "+" or "-", so a patch that merely mentions a header can't smuggle one in.
 */
export function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/.exec(line);
    if (m) paths.push(m[1].trim());
  }
  return paths;
}

function decidePath(
  i: GuardInput, raw: string, write: boolean, home: string, hasLocks: boolean,
  lockedChecks: Map<string, ReturnType<typeof activePromises>[number]>
): GuardDecision {
  if (inside(home, fold(slashes(resolve(i.root, raw))))) return deny(guardText.home);
  if (!write) return ALLOW;

  const rel = projectRel(i.root, raw);
  if (rel === null || !rel.startsWith(`${STATE_DIR}/`)) return ALLOW;
  if (rel === `${STATE_DIR}/promises.jsonl`) return deny(guardText.ledger);
  if (rel === `${STATE_DIR}/keys` || rel.startsWith(`${STATE_DIR}/keys/`)) return deny(guardText.keys);
  const p = lockedChecks.get(rel);
  if (p) return deny(guardText.check(p.number, p.sentence));
  if (hasLocks && !rel.startsWith(`${STATE_DIR}/checks/`) && !rel.startsWith(`${STATE_DIR}/runs/`)) {
    return deny(guardText.config(rel));
  }
  return ALLOW;
}
