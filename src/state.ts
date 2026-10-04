import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mirrorDir } from "./mirror.ts";
import { homeDir } from "./sign.ts";
import type { State } from "./types.ts";

/** Start "due" for a nudge, so the first approval of a session can prompt one. */
export function defaultState(): State {
  return { lastGreenTree: null, promptsSinceNudge: 5, lastBlockKey: null, consecutiveBlocks: 0 };
}

/**
 * Kept next to the mirror, not in the repo: `lastGreenTree` lets a stop skip
 * the browser, so a copy the agent could write would be a way to skip it.
 */
export function statePath(root: string, home: string = homeDir()): string {
  return join(mirrorDir(root, home), "state.json");
}

/** Corrupt or missing state is not an error: it only holds caches and counters. */
export function loadState(root: string, home: string = homeDir()): State {
  const path = statePath(root, home);
  if (!existsSync(path)) return defaultState();
  try {
    return { ...defaultState(), ...(JSON.parse(readFileSync(path, "utf8")) as Partial<State>) };
  } catch {
    return defaultState();
  }
}

export function saveState(root: string, state: State, home: string = homeDir()): void {
  const path = statePath(root, home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}
