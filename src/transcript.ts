import { existsSync, readFileSync } from "node:fs";

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
export function verifyWords(transcriptPath: string, promptId: string, words: string): WordsCheck {
  if (!transcriptPath || !existsSync(transcriptPath)) return "missing";
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
