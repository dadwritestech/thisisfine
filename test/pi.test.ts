import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import thisisfine from "../integrations/pi/index.ts";
import type { PiApi } from "../integrations/pi/index.ts";
import { fileHash } from "../src/hash.ts";
import { readLedger } from "../src/ledger.ts";
import { verifyWords } from "../src/transcript.ts";
import type { LedgerRecord } from "../src/types.ts";
import { cleanEnv, lock, proposal, put, tempDir } from "./helpers.ts";

const BIN = resolve("bin/thisisfine.mjs");
const CHECK = ".thisisfine/checks/1-badge.spec.ts";

function project(lines: LedgerRecord[] = [proposal()]) {
  const root = tempDir();
  const home = join(tempDir(), "home");
  put(root, ".thisisfine/config.json", JSON.stringify({ start: "node server.js" }));
  put(root, CHECK, "import { test } from '@playwright/test';\ntest('badge', async () => {});\n");
  const hash = fileHash(join(root, CHECK));
  put(root, ".thisisfine/promises.jsonl", lines.map((l) => JSON.stringify({ ...l, checkHash: hash }) + "\n").join(""));
  return { root, home };
}

function hook(name: string, stdin: object, home: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, name], {
    encoding: "utf8", input: JSON.stringify({ agent: "pi", ...stdin }), env: { ...cleanEnv(), THISISFINE_HOME: home, ...env }
  });
  return { code: r.status, stdout: r.stdout, json: () => JSON.parse(r.stdout) as Record<string, any> };
}

const locks = (root: string) => readLedger(join(root, ".thisisfine/promises.jsonl")).filter((r) => r.kind === "lock");

// ── the CLI, in pi's shape ──────────────────────────────────────────────

test("pi hook-prompt: a y locks, the record says pi, and the answer is neutral JSON", () => {
  const { root, home } = project();
  const r = hook("hook-prompt", { cwd: root, prompt: "y", prompt_id: "leaf1", session_id: "s1", transcript_path: "/tmp/s.jsonl" }, home);
  const out = r.json();
  assert.match(out.notice, /Locked promise #1/);
  assert.match(out.context, /now locked/);
  assert.equal(out.hookSpecificOutput, undefined);
  const [l] = locks(root);
  assert.ok(l && l.kind === "lock");
  assert.equal(l.agent, "pi");
});

test("pi hook-prompt: a nested agent's y neither locks nor dismisses", () => {
  for (const env of [{ PI_SESSION_ID: "outer" }, { THISISFINE_UNDER_AGENT: "pi" }] as Record<string, string>[]) {
    const { root, home } = project();
    const r = hook("hook-prompt", { cwd: root, prompt: "y", prompt_id: "leaf1", session_id: "s1" }, home, env);
    assert.match(r.json().context, /started from inside another agent/);
    assert.equal(locks(root).length, 0);
    assert.equal(readLedger(join(root, ".thisisfine/promises.jsonl")).some((x) => x.kind === "dismiss"), false);
  }
});

test("pi hook-guard: lowercase tool names are guarded, and so is touching the nested-agent marker", () => {
  const { root, home } = project([proposal(), lock()]);
  const edit = hook("hook-guard", { cwd: root, tool_name: "edit", tool_input: { path: join(root, CHECK) } }, home);
  assert.match(edit.json().deny, /promise #1/);
  const bash = hook("hook-guard", { cwd: root, tool_name: "bash", tool_input: { command: "env -u PI_SESSION_ID pi -p y" } }, home);
  assert.match(bash.json().deny, /Leave it alone/);
  const fine = hook("hook-guard", { cwd: root, tool_name: "read", tool_input: { path: join(root, "README.md") } }, home);
  assert.equal(fine.stdout, "");
});

test("pi hook-stop names pi, not Claude, when it lets go", () => {
  const { root, home } = project([proposal(), lock({ checkHash: "0".repeat(16) })]);
  const r = hook("hook-stop", { cwd: root }, home);
  assert.ok(r.json().block);
  assert.doesNotMatch(r.stdout, /Claude/);
});

// ── pi's session file ───────────────────────────────────────────────────

function session(entries: object[]) {
  const dir = tempDir();
  const path = join(dir, "s.jsonl");
  writeFileSync(path, entries.map((e) => JSON.stringify(e) + "\n").join(""));
  return path;
}
const msg = (id: string, parentId: string | null, role: string, text: string, timestamp = "2026-10-06T10:00:00.000Z") =>
  ({ type: "message", id, parentId, timestamp, message: { role, content: [{ type: "text", text }] } });

test("verifyWords (pi): the words must be a user message filed under the prompt id", () => {
  const path = session([msg("a", null, "user", "hi"), msg("b", "a", "assistant", "proposal"), msg("c", "b", "user", "y")]);
  assert.equal(verifyWords(path, "b", "y", "pi"), "verified");
  assert.equal(verifyWords(path, "b", "yes", "pi"), "not-found");
});

test("verifyWords (pi): a tool result that says y is not a user message", () => {
  const path = session([msg("a", null, "user", "hi"), msg("b", "a", "assistant", "proposal"), msg("c", "b", "toolResult", "y")]);
  assert.equal(verifyWords(path, "b", "y", "pi", "2026-10-06T10:00:00.000Z"), "not-found");
});

test("verifyWords (pi): a reply queued while pi was busy is found by time", () => {
  const path = session([
    msg("a", null, "user", "hi", "2026-10-06T09:00:00.000Z"), msg("b", "a", "assistant", "proposal", "2026-10-06T09:00:05.000Z"),
    msg("c", "b", "toolResult", "ok", "2026-10-06T10:00:01.000Z"), msg("d", "c", "user", "y", "2026-10-06T10:00:02.000Z")
  ]);
  assert.equal(verifyWords(path, "zzz", "y", "pi", "2026-10-06T10:00:00.000Z"), "verified");
  assert.equal(verifyWords(path, "zzz", "y", "pi", "2026-10-06T10:01:00.000Z"), "not-found");
  assert.equal(verifyWords(join(tempDir(), "gone.jsonl"), "b", "y", "pi"), "missing");
});

// ── the extension, against a fake pi and the real CLI ───────────────────

type Handler = (event: any, ctx: any) => any;

function load(root: string, home: string, opts: { leaf?: string; env?: Record<string, string> } = {}) {
  const saved = { ...process.env };
  for (const k of ["THISISFINE_UNDER_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE"]) delete process.env[k];
  Object.assign(process.env, { THISISFINE_HOME: home, ...opts.env });
  const handlers = new Map<string, Handler>();
  const sent: { message: any; options: any }[] = [];
  const notices: string[] = [];
  const api: PiApi = {
    on: (event, h) => void handlers.set(event, h),
    sendMessage: (message, options) => void sent.push({ message, options })
  };
  thisisfine(api, { bin: BIN });
  const marker = process.env.THISISFINE_UNDER_AGENT;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  const ctx = {
    cwd: root,
    ui: { notify: (m: string) => void notices.push(m) },
    sessionManager: { getSessionFile: () => join(root, "session.jsonl"), getSessionId: () => "sess1", getLeafId: () => opts.leaf ?? "leaf1" }
  };
  const fire = (event: string, payload: object) => handlers.get(event)!(payload, ctx);
  return { fire, sent, notices, marker, handlers };
}

test("extension: marks the process so a pi started from pi's bash tool is recognised", () => {
  const { root, home } = project();
  assert.equal(load(root, home).marker, "pi");
});

test("extension: a human y locks, tells the model next turn, and tells the human", async () => {
  const { root, home } = project();
  const pi = load(root, home);
  await pi.fire("input", { text: "y", source: "interactive" });
  const [l] = locks(root);
  assert.ok(l && l.kind === "lock");
  assert.equal(l.promptId, "leaf1");
  assert.equal(l.agent, "pi");
  assert.match(pi.notices.join("\n"), /Locked promise #1/);
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].options.deliverAs, "nextTurn");
  assert.equal(pi.sent[0].message.display, false);
});

test("extension: a reply typed mid-run is queued the way pi queued it", async () => {
  const { root, home } = project();
  const pi = load(root, home);
  await pi.fire("input", { text: "y", source: "interactive", streamingBehavior: "steer" });
  assert.equal(pi.sent[0].options.deliverAs, "steer");
});

test("extension: a message another extension injected is never read as a yes", async () => {
  const { root, home } = project();
  const pi = load(root, home);
  await pi.fire("input", { text: "y", source: "extension" });
  assert.equal(locks(root).length, 0);
  assert.equal(pi.sent.length, 0);
});

test("extension: started from inside another agent, it refuses to lock and says why", async () => {
  const { root, home } = project();
  const pi = load(root, home, { env: { PI_SESSION_ID: "outer" } });
  await pi.fire("input", { text: "y", source: "interactive" });
  assert.equal(locks(root).length, 0);
  assert.match(pi.notices.join("\n"), /started from inside an agent session/);
});

test("extension: does nothing in a folder with no thisisfine config", async () => {
  const dir = tempDir();
  const pi = load(dir, join(dir, "home"));
  assert.equal(await pi.fire("input", { text: "y", source: "interactive" }), undefined);
  assert.equal(await pi.fire("tool_call", { toolName: "bash", input: { command: "rm -rf x" } }), undefined);
  assert.equal(await pi.fire("resources_discover", {}), undefined);
  assert.equal(pi.sent.length, 0);
});

test("extension: session context joins the system prompt; skills and prompts are offered", async () => {
  const { root, home } = project();
  const pi = load(root, home);
  const r = await pi.fire("before_agent_start", { systemPrompt: "BASE" });
  assert.match(r.systemPrompt, /^BASE\n\n\[thisisfine\]/);
  const res = await pi.fire("resources_discover", {});
  assert.match(res.skillPaths[0], /skills$/);
  assert.match(res.promptPaths[0], /commands$/);
  await pi.fire("session_start", {});
  assert.match(pi.notices.join("\n"), /waiting for your answer/);
});

test("extension: tool_call blocks edits to a locked check and lets reads through", async () => {
  const { root, home } = project([proposal(), lock()]);
  const pi = load(root, home);
  const blocked = await pi.fire("tool_call", { toolName: "edit", input: { path: join(root, CHECK) } });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /promise #1/);
  assert.equal(await pi.fire("tool_call", { toolName: "read", input: { path: join(root, "README.md") } }), undefined);
  assert.equal(await pi.fire("tool_call", { toolName: "mcp_thing", input: {} }), undefined);
});

test("extension: a broken ledger at agent_end sends the agent back with a follow-up that continues the run", async () => {
  const { root, home } = project();
  const pi = load(root, home);
  await pi.fire("input", { text: "y", source: "interactive" });
  pi.sent.length = 0;
  appendFileSync(join(root, CHECK), "// edited after the human said yes\n");
  await pi.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].message.customType, "thisisfine-gate");
  assert.deepEqual(pi.sent[0].options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(pi.sent[0].message.content, /NOT fine/);
  assert.match(pi.notices.join("\n"), /NOT fine/);
});

test("extension: an aborted run is not gated, and a clean one is let go", async () => {
  const { root, home } = project();
  const pi = load(root, home);
  await pi.fire("input", { text: "y", source: "interactive" });
  pi.sent.length = 0;
  appendFileSync(join(root, CHECK), "// edited\n");
  await pi.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
  assert.equal(pi.sent.length, 0);

  const clean = project();
  const pi2 = load(clean.root, clean.home);
  await pi2.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(pi2.sent.length, 0);
});
