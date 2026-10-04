import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { State } from "./types.ts";
import { STATE_DIR } from "./types.ts";

/** Start "due" for a nudge, so the first approval of a session can prompt one. */
export function defaultState(): State {
  return { lastGreenTree: null, promptsSinceNudge: 5, lastBlockKey: null, consecutiveBlocks: 0 };
}

export function statePath(root: string): string {
  return join(root, STATE_DIR, "state.json");
}

/** Corrupt or missing state is not an error: it only holds caches and counters. */
export function loadState(root: string): State {
  const path = statePath(root);
  if (!existsSync(path)) return defaultState();
  try {
    return { ...defaultState(), ...(JSON.parse(readFileSync(path, "utf8")) as Partial<State>) };
  } catch {
    return defaultState();
  }
}

export function saveState(root: string, state: State): void {
  const path = statePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}
