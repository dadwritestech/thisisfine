import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { STATE_DIR } from "./types.ts";

/**
 * The nearest directory with `.thisisfine/config.json`. Not just `.thisisfine/`:
 * that's also the name of the home dir. Its own module so the pi extension can
 * ask "is this a thisisfine project?" without loading the whole CLI.
 */
export function findRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, STATE_DIR, "config.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
