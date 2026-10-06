import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STATE_DIR } from "./types.ts";

/** Commits thisisfine makes for itself never depend on the user's git identity. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "thisisfine", GIT_AUTHOR_EMAIL: "thisisfine@localhost",
  GIT_COMMITTER_NAME: "thisisfine", GIT_COMMITTER_EMAIL: "thisisfine@localhost"
};

export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return gitRaw(cwd, args, env).trim();
}

/** Untrimmed, for column-sensitive output: porcelain's first line can start with a space. */
function gitRaw(cwd: string, args: string[], env: Record<string, string> = {}): string {
  try {
    return execFileSync("git", args, {
      cwd, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024
    });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")}: ${(e.stderr || e.message).trim()}`);
  }
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string | null {
  const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  return top ? resolve(top) : null;
}

export function resolveRef(root: string, ref: string): string | null {
  return tryGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

/**
 * A file's content at a commit, or null if that commit doesn't have it.
 * `rel` is relative to `cwd` (git's `<ref>:./path`), so a project in a
 * subfolder of the repo works. An unknown ref throws: "no promises at base"
 * and "base doesn't exist" must not look the same.
 */
export function fileAtRef(cwd: string, ref: string, rel: string): string | null {
  const sha = resolveRef(cwd, ref);
  if (!sha) throw new Error(`${ref} is not a commit here. In CI, fetch it first (actions/checkout with fetch-depth: 0).`);
  const spec = `${sha}:./${rel}`;
  if (tryGit(cwd, ["cat-file", "-e", spec]) === null) return null;
  return gitRaw(cwd, ["show", spec]);
}

/**
 * The id of the working tree *as it is on disk*: modified and untracked
 * files included, .gitignore honoured. Computed in a throwaway copy of the
 * index so the user's staging area is never touched; copying the real index
 * first keeps its stat cache, which is what makes this fast on big repos.
 */
export function treeId(root: string): string {
  const realIndex = resolve(root, git(root, ["rev-parse", "--git-path", "index"]));
  const tmp = join(tmpdir(), `thisisfine-index-${process.pid}-${randomUUID()}`);
  if (existsSync(realIndex)) copyFileSync(realIndex, tmp);
  try {
    git(root, ["add", "-A"], { GIT_INDEX_FILE: tmp });
    return git(root, ["write-tree"], { GIT_INDEX_FILE: tmp });
  } finally {
    rmSync(tmp, { force: true });
    rmSync(`${tmp}.lock`, { force: true });
  }
}

/** A dangling commit of the current working tree, parented on HEAD. HEAD and the index don't move. */
export function snapshotCommit(root: string): string {
  const tree = treeId(root);
  const parent = resolveRef(root, "HEAD") ? ["-p", "HEAD"] : [];
  return git(root, ["commit-tree", tree, ...parent, "-m", "thisisfine snapshot"], IDENTITY);
}

/**
 * The version of the app to prove against when no `--base` is given: the
 * last commit if the app has uncommitted changes (the behaviour was most
 * likely just built), else the commit before. Changes under `.thisisfine/`
 * don't count: the check the agent just wrote is not the behaviour.
 */
export function defaultBase(root: string): string | null {
  if (!resolveRef(root, "HEAD")) return null;
  const dirty = git(root, ["status", "--porcelain", "--", ".", `:(exclude)${STATE_DIR}`]) !== "";
  if (dirty) return "HEAD";
  return resolveRef(root, "HEAD~1") ? "HEAD~1" : null;
}

export function addWorktree(root: string, sha: string, dir: string): void {
  git(root, ["worktree", "add", "--detach", "--force", dir, sha]);
}

/**
 * Make a fresh worktree runnable: copy the untracked files the app needs
 * (`.env` and friends, from config) and link node_modules rather than
 * reinstalling. A junction on Windows needs no admin rights.
 */
export function prepareWorktree(root: string, dir: string, copy: string[]): void {
  for (const rel of copy) {
    const from = join(root, rel);
    const to = join(dir, rel);
    if (existsSync(from) && !existsSync(to)) cpSync(from, to, { recursive: true });
  }
  const modules = join(root, "node_modules");
  const link = join(dir, "node_modules");
  if (existsSync(modules) && !existsSync(link)) symlinkSync(modules, link, "junction");
}

/**
 * Unlink node_modules *before* asking git to delete the worktree: a
 * recursive delete that followed the link would empty the user's real
 * node_modules.
 */
export function removeWorktree(root: string, dir: string): void {
  const link = join(dir, "node_modules");
  try {
    if (lstatSync(link).isSymbolicLink()) {
      try {
        unlinkSync(link);
      } catch {
        rmdirSync(link);
      }
    }
  } catch {
    // no link to remove
  }
  tryGit(root, ["worktree", "remove", "--force", dir]);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  tryGit(root, ["worktree", "prune"]);
}

/**
 * Size and mtime of every file git would mention: modified, untracked and,
 * crucially, gitignored. Apps keep their real data in ignored files
 * (config.json, *.db), and a check that clicks "Save" writes to them.
 * Wholly ignored directories (node_modules/, caches) are listed by git as
 * one entry and skipped here: churn, not data. So is thisisfine's own dir.
 */
export function footprint(root: string): Map<string, string> {
  const raw = gitRaw(root, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"]);
  const parts = raw.split("\0");
  const files = new Map<string, string>();
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    if (/[RC]/.test(entry.slice(0, 2))) i++; // a rename's old path follows; it no longer exists
    const rel = entry.slice(3);
    if (rel.endsWith("/") || rel.startsWith(`${STATE_DIR}/`)) continue;
    let sig = "gone";
    try {
      const s = statSync(join(root, rel));
      sig = `${s.size}:${s.mtimeMs}`;
    } catch {
      // deleted: "gone" is its signature
    }
    files.set(rel, sig);
  }
  return files;
}

/** Files that appeared, changed or disappeared since `before`, sorted. */
export function changedSince(root: string, before: Map<string, string>): string[] {
  const after = footprint(root);
  return [...after].filter(([rel, sig]) => before.get(rel) !== sig).map(([rel]) => rel).sort();
}

/** `--recount`: hunk line counts in hand-written (and agent-written) patches are often wrong. */
export function applyPatch(dir: string, patchPath: string): void {
  try {
    git(dir, ["apply", "--recount", "--whitespace=nowarn", resolve(patchPath)]);
  } catch (err) {
    throw new Error(`sabotage patch does not apply: ${err instanceof Error ? err.message : String(err)}`);
  }
}
