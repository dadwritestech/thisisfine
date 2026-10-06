import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addWorktree, applyPatch, blobOf, changedPaths, changedSince, defaultBase, fileAtRef, footprint, prepareWorktree, removeWorktree, repoRoot, resolveRef, snapshotCommit, treeBlobs, treeId } from "../src/git.ts";
import { commitAll, initRepo, put, sh, tempDir } from "./helpers.ts";

function repo(): string {
  const root = initRepo(tempDir());
  put(root, "app.js", "v1\n");
  put(root, ".gitignore", "node_modules/\n*.log\n");
  commitAll(root, "v1");
  return root;
}

test("repoRoot finds the top level from a subdirectory", () => {
  const root = repo();
  put(root, "sub/x.txt", "x");
  assert.equal(repoRoot(join(root, "sub"))?.toLowerCase(), resolve(root).toLowerCase());
  assert.equal(repoRoot(tempDir()), null);
});

test("treeId sees modified and untracked files, ignores gitignored ones, and touches nothing", () => {
  const root = repo();
  const t0 = treeId(root);
  put(root, "debug.log", "noise");
  assert.equal(treeId(root), t0, "ignored file changes nothing");
  put(root, "new.js", "untracked");
  const t1 = treeId(root);
  assert.notEqual(t1, t0);
  put(root, "app.js", "v2\n");
  assert.notEqual(treeId(root), t1);
  assert.match(sh(root, "git", ["status", "--porcelain"]), /\?\? new\.js/, "real index untouched");
});

test("footprint names the project files an app run wrote, including gitignored ones", () => {
  const root = repo();
  put(root, ".gitignore", "node_modules/\n*.log\nconfig.json\ncache/\n");
  put(root, "config.json", '{"theme":""}');
  commitAll(root, "ignore more");
  const before = footprint(root);
  put(root, "config.json", '{"theme":"dark"}'); // the app saved a setting: the case that matters
  put(root, "app.js", "v2\n");                   // tracked file edited
  put(root, "uploads.txt", "new");               // untracked file created
  put(root, "server.log", "noise");              // ignored file created
  put(root, "cache/blob", "x");                  // inside an ignored directory: not listed, by design
  put(root, ".thisisfine/runs/r/report.json", "{}"); // thisisfine's own output
  assert.deepEqual(changedSince(root, before), ["app.js", "config.json", "server.log", "uploads.txt"]);
  assert.deepEqual(changedSince(root, footprint(root)), [], "nothing changed since the second snapshot");
});

test("snapshotCommit captures the working tree without moving HEAD or the index", () => {
  const root = repo();
  const head = sh(root, "git", ["rev-parse", "HEAD"]);
  put(root, "app.js", "v2-uncommitted\n");
  const snap = snapshotCommit(root);
  assert.equal(sh(root, "git", ["rev-parse", "HEAD"]), head);
  assert.equal(sh(root, "git", ["show", `${snap}:app.js`]), "v2-uncommitted");
  assert.equal(sh(root, "git", ["rev-parse", `${snap}^`]), head);
  assert.equal(sh(root, "git", ["diff", "--cached", "--name-only"]), "", "nothing staged");
  assert.equal(sh(root, "git", ["diff", "--name-only"]), "app.js");
});

test("defaultBase: HEAD when dirty, HEAD~1 when clean, null with nothing to compare", () => {
  const root = repo();
  assert.equal(defaultBase(root), null, "single clean commit");
  put(root, "app.js", "v2\n");
  assert.equal(defaultBase(root), "HEAD");
  commitAll(root, "v2");
  assert.equal(defaultBase(root), "HEAD~1");
  put(root, ".thisisfine/checks/1-x.spec.ts", "new check");
  assert.equal(defaultBase(root), "HEAD~1", "a new check alone is not an app change");
  assert.equal(resolveRef(root, "HEAD~5"), null);
  assert.match(resolveRef(root, "HEAD~1") ?? "", /^[0-9a-f]{40}$/);
});

test("worktree add, prepare (copy + node_modules link), patch, remove", () => {
  const root = repo();
  put(root, ".env", "SECRET=1\n");
  put(root, "node_modules/dep/index.js", "module.exports = 1;\n");
  put(root, "app.js", "v2\n");
  const dir = join(tempDir(), "wt");
  addWorktree(root, snapshotCommit(root), dir);
  prepareWorktree(root, dir, [".env"]);
  assert.equal(readFileSync(join(dir, "app.js"), "utf8"), "v2\n");
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "SECRET=1\n");
  assert.ok(existsSync(join(dir, "node_modules/dep/index.js")));

  const patch = join(tempDir(), "sabotage.patch");
  writeFileSync(patch, "--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-v2\n+sabotaged\n");
  applyPatch(dir, patch);
  assert.equal(readFileSync(join(dir, "app.js"), "utf8"), "sabotaged\n");
  assert.throws(() => applyPatch(dir, patch), /patch/i, "second apply no longer matches");

  removeWorktree(root, dir);
  assert.equal(existsSync(dir), false);
  assert.ok(existsSync(join(root, "node_modules/dep/index.js")), "linked node_modules survives removal");
  rmSync(join(root, "node_modules"), { recursive: true });
});

test("treeBlobs maps every blob in a tree to its paths, and blobOf hashes bytes the way git does", () => {
  const root = repo();
  put(root, "public/a.js", "same\n");
  put(root, "public/b.js", "same\n");
  const tree = treeId(root);
  const blobs = treeBlobs(root, tree);
  assert.deepEqual(blobs.get(blobOf(Buffer.from("same\n"))), ["public/a.js", "public/b.js"]);
  assert.deepEqual(blobs.get(blobOf(Buffer.from("v1\n"))), ["app.js"]);
  assert.equal(blobOf(Buffer.from("v1\n")), sh(root, "git", ["hash-object", "app.js"]));
});

test("changedPaths lists what differs between a tree and now; null when the old tree is gone", () => {
  const root = repo();
  put(root, "old name.js", "x\n");
  const t1 = treeId(root);
  put(root, "app.js", "v2\n");
  rmSync(join(root, "old name.js"));
  put(root, "new name.js", "x\n");
  const t2 = treeId(root);
  assert.deepEqual(changedPaths(root, t1, t2), ["app.js", "new name.js", "old name.js"], "renames show both sides");
  assert.deepEqual(changedPaths(root, t1, t1), []);
  assert.equal(changedPaths(root, "0123456789abcdef0123456789abcdef01234567", t2), null);
});

test("fileAtRef reads a file as it was at a commit, relative to a project in a subfolder", () => {
  const root = initRepo(tempDir());
  put(root, "web/.thisisfine/promises.jsonl", "old\n");
  const first = commitAll(root, "one");
  put(root, "web/.thisisfine/promises.jsonl", "new\n");
  commitAll(root, "two");
  assert.equal(fileAtRef(join(root, "web"), first, ".thisisfine/promises.jsonl"), "old\n");
  assert.equal(fileAtRef(join(root, "web"), "HEAD", ".thisisfine/promises.jsonl"), "new\n");
});

test("fileAtRef is null for a file the commit doesn't have, and throws for a ref that doesn't exist", () => {
  const root = repo();
  assert.equal(fileAtRef(root, "HEAD", ".thisisfine/promises.jsonl"), null);
  assert.throws(() => fileAtRef(root, "no-such-branch", ".thisisfine/promises.jsonl"), /no-such-branch/);
});
