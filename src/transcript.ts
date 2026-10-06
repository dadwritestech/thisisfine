import { existsSync, readFileSync } from "node:fs";
import type { Agent } from "./types.ts";

export type WordsCheck = "verified" | "not-human" | "not-found" | "missing";

interface Entry {
  type?: string;
  promptId?: string;
  origin?: { kind?: string };
  message?: { content?: unknown };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string }) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
    .join("");
}

/**
 * An after-the-fact audit of a signed "yes": does Claude Code's own
 * transcript show a person typing those words under that prompt id? Tool
 * results are also `type: "user"` entries, so `origin.kind` is what tells a
 * human apart from anything an agent produced. Transcripts are cleaned up
 * after a while, so a missing file is "can't re-check", not "forged".
 */
export function verifyWords(transcriptPath: string, promptId: string, words: string, agent: Agent = "claude", at = ""): WordsCheck {
  if (!transcriptPath || !existsSync(transcriptPath)) return "missing";
  if (agent === "pi") return verifyPiWords(transcriptPath, promptId, words, at);
  let sawId = false;
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.includes(promptId)) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (e.type !== "user" || e.promptId !== promptId) continue;
    if (textOf(e.message?.content).trim() !== words.trim()) continue;
    if (e.origin?.kind === "human") return "verified";
    sawId = true;
  }
  return sawId ? "not-human" : "not-found";
}

interface PiEntry {
  type?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/** pi's own write lags the hook by milliseconds; a clock this far off is something else. */
const PI_SKEW_MS = 5000;

/**
 * pi's session file has no origin field: a typed message and one an
 * extension injected look the same, so the best this can say is "found".
 * What it can pin is position. The lock's `promptId` is the session leaf
 * when pi's `input` event fired, and pi appends the prompt as that leaf's
 * child, so the words must sit in a user message whose parent is that id.
 * `toolResult` entries have their own role and never match.
 *
 * A reply typed while pi is still working is queued and lands later, under
 * a different parent. Then the words must be the first user message pi
 * wrote after the lock was signed (`at`).
 */
function verifyPiWords(transcriptPath: string, promptId: string, words: string, at: string): WordsCheck {
  const since = Date.parse(at) - PI_SKEW_MS;
  let firstAfter: string | null = null;
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.includes('"user"')) continue;
    let e: PiEntry;
    try {
      e = JSON.parse(line) as PiEntry;
    } catch {
      continue;
    }
    if (e.type !== "message" || e.message?.role !== "user") continue;
    const text = textOf(e.message.content).trim();
    if ((e.parentId ?? "") === promptId && text === words.trim()) return "verified";
    if (firstAfter === null && Date.parse(e.timestamp ?? "") >= since) firstAfter = text;
  }
  return firstAfter === words.trim() ? "verified" : "not-found";
}
