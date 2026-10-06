import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRoot } from "../../src/root.ts";
import { NESTED_AGENT_ENVS, UNDER_AGENT_ENV } from "../../src/types.ts";

/**
 * thisisfine for pi. The same four guarantees as the Claude Code plugin,
 * with every decision made by the CLI (`bin/thisisfine.mjs hook-*`): this
 * file only translates pi's events into hook input and the answer back into
 * pi's actions. Structural types below instead of a pi dependency, so the
 * package keeps zero runtime deps.
 */

interface Ctx {
  cwd: string;
  hasUI?: boolean;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  sessionManager: { getSessionFile(): string | undefined; getSessionId(): string; getLeafId(): string | null };
}

type Handler = (event: any, ctx: Ctx) => unknown;

export interface PiApi {
  on(event: string, handler: Handler): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { deliverAs?: string; triggerTurn?: boolean }): void;
}

interface HookResult {
  context?: string;
  notice?: string;
  deny?: string;
  block?: string;
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(REPO, "bin", "thisisfine.mjs");

/** pi's tool names, lowercase. The guard folds case, so the same rules apply as for Claude Code's. */
const GUARDED = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);

const STOP_TIMEOUT_MS = 300_000;
const QUICK_TIMEOUT_MS = 30_000;

export default function thisisfine(pi: PiApi, options: { bin?: string } = {}): void {
  const bin = options.bin ?? BIN;
  // Taken before the marker is set: if one is already there, an agent started this pi.
  const baseEnv = { ...process.env };
  const nested = NESTED_AGENT_ENVS.find((name) => baseEnv[name]) ?? null;
  // Everything pi's bash tool starts inherits this, so a `pi -p y` run by the agent sees it.
  process.env[UNDER_AGENT_ENV] = "pi";

  function hook(name: string, input: object, timeoutMs: number): Promise<HookResult | null> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, name], { env: baseEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", () => {});
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || !stdout.trim()) return resolve(null);
        try {
          resolve(JSON.parse(stdout) as HookResult);
        } catch {
          resolve(null);
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ agent: "pi", ...input }));
    });
  }

  const rootOf = (ctx: Ctx) => findRoot(ctx.cwd);
  const session = (ctx: Ctx) => ({
    session_id: ctx.sessionManager.getSessionId(),
    transcript_path: ctx.sessionManager.getSessionFile() ?? ""
  });

  pi.on("resources_discover", (_e, ctx) => {
    if (!rootOf(ctx)) return undefined;
    return { skillPaths: [join(REPO, "skills")], promptPaths: [join(REPO, "commands")] };
  });

  pi.on("session_start", async (_e, ctx) => {
    if (!rootOf(ctx)) return;
    const r = await hook("hook-session", { cwd: ctx.cwd }, QUICK_TIMEOUT_MS);
    if (r?.notice) ctx.ui.notify(r.notice, "info");
  });

  // Session context rides on the system prompt, which is rebuilt every turn.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!rootOf(ctx)) return undefined;
    const r = await hook("hook-session", { cwd: ctx.cwd }, QUICK_TIMEOUT_MS);
    if (!r?.context) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${r.context}` };
  });

  pi.on("input", async (event, ctx) => {
    // Messages an extension injected (including this one's own) are never a person's reply.
    if (event.source === "extension" || !rootOf(ctx)) return undefined;
    if (nested) {
      ctx.ui.notify(`thisisfine: this pi was started from inside an agent session (${nested} is set), so it can't lock or retire promises.`, "warning");
      return undefined;
    }
    const r = await hook("hook-prompt", {
      cwd: ctx.cwd, prompt: event.text,
      // The session leaf before this prompt: pi files the prompt as its child, which is how `verify` finds it again.
      prompt_id: ctx.sessionManager.getLeafId() ?? "", ...session(ctx)
    }, QUICK_TIMEOUT_MS);
    if (!r) return undefined;
    if (r.notice) ctx.ui.notify(r.notice, "info");
    if (r.context) {
      pi.sendMessage({ customType: "thisisfine", content: r.context, display: false }, { deliverAs: event.streamingBehavior ?? "nextTurn" });
    }
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!GUARDED.has(String(event.toolName).toLowerCase()) || !rootOf(ctx)) return undefined;
    const r = await hook("hook-guard", { cwd: ctx.cwd, tool_name: event.toolName, tool_input: event.input }, QUICK_TIMEOUT_MS);
    // A crashed guard allows, like the Claude plugin: the signature check at the gate is the backstop.
    return r?.deny ? { block: true, reason: r.deny } : undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!rootOf(ctx)) return;
    const last = [...(event.messages ?? [])].reverse().find((m: { role?: string }) => m.role === "assistant");
    if (last && (last.stopReason === "aborted" || last.stopReason === "error")) return;
    const r = await hook("hook-stop", { cwd: ctx.cwd, ...session(ctx) }, STOP_TIMEOUT_MS);
    if (!r) return;
    if (r.notice) ctx.ui.notify(r.notice, r.block ? "warning" : "info");
    if (r.block) {
      // Queued during agent_end, a follow-up keeps the run going: pi's equivalent of a blocked Stop.
      pi.sendMessage({ customType: "thisisfine-gate", content: r.block, display: true }, { deliverAs: "followUp", triggerTurn: true });
    }
  });
}
