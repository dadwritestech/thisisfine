import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STATE_DIR } from "./types.ts";

/** Commits thisisfine makes for itself never depend on the user's git identity. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "thisisfine", GIT_AUTHOR_EMAIL: "thisisfine@localhost",
  GIT_COMMITTER_NAME: "thisisfine", GIT_COMMITTER_EMAIL: "thisisfine@localhost"
};

export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  try {
    return execFileSync("git", args, {
      cwd, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024
    }).trim();
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

/** `--recount`: hunk line counts in hand-written (and agent-written) patches are often wrong. */
export function applyPatch(dir: string, patchPath: string): void {
  try {
    git(dir, ["apply", "--recount", "--whitespace=nowarn", resolve(patchPath)]);
  } catch (err) {
    throw new Error(`sabotage patch does not apply: ${err instanceof Error ? err.message : String(err)}`);
  }
}
