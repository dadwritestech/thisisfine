import type { Coverage } from "./types.ts";
import { STATE_DIR } from "./types.ts";

/** Partial runs in a row before the gate runs everything anyway. */
export const FULL_EVERY_RUNS = 5;
/** A map older than this is not trusted. */
export const FULL_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * One request a check's browser made, as the recording proxy saw it.
 * `blob` is the git blob id of the decoded response body, null when there
 * was no body to hash (tunnels, upgrades, bodies that wouldn't decode).
 */
export interface Hit {
  method: string;
  url: string;
  status: number;
  blob: string | null;
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h);
}

function hostOf(hit: Hit): string | null {
  try {
    return hit.method === "CONNECT" ? new URL(`http://${hit.url}`).hostname : new URL(hit.url).hostname;
  } catch {
    return null;
  }
}

/**
 * A check's own `request` fixture, `fetch` or `http` never passes the
 * browser's proxy, so what it reaches can't be seen. Such a check is dynamic.
 */
export function usesOwnHttp(source: string): boolean {
  return /\brequest\b|\bfetch\s*\(|node:https?\b|\bAPIRequest/.test(source);
}

export interface CoverageInput {
  tree: string;
  madeAt: string;
  /** Every blob in `tree` → the paths that hold it. */
  blobs: Map<string, string[]>;
  hits: Map<string, Hit[]>;
  /** Checks whose source makes HTTP calls outside the browser. */
  ownHttp: string[];
}

/**
 * Turns one full run's traffic into a map. A response is explained only by
 * a 200-range GET whose body is a file in the tree; a body that several
 * files share explains the response but maps no file, so a change to any of
 * them stays unmapped and runs everything. Anything else from this machine
 * (APIs, errors, websockets, tunnels) makes the check dynamic. Other hosts
 * aren't the repo's code and are ignored, as is the favicon browsers guess at.
 */
export function buildCoverage(i: CoverageInput): Coverage {
  const files = new Map<string, Set<string>>();
  const dynamic = new Set(i.ownHttp.filter((c) => i.hits.has(c)));
  for (const [check, hits] of i.hits) {
    for (const hit of hits) {
      const host = hostOf(hit);
      if (host === null) {
        dynamic.add(check);
        continue;
      }
      if (!isLoopback(host)) continue;
      const path = hit.method === "CONNECT" ? "" : new URL(hit.url).pathname;
      if (hit.method === "GET" && hit.status === 404 && path === "/favicon.ico") continue;
      const paths = hit.method === "GET" && hit.status >= 200 && hit.status < 300 && hit.blob ? i.blobs.get(hit.blob) : undefined;
      if (!paths) {
        dynamic.add(check);
        continue;
      }
      if (paths.length !== 1) continue;
      const set = files.get(paths[0]!) ?? new Set();
      set.add(check);
      files.set(paths[0]!, set);
    }
  }
  return {
    tree: i.tree,
    madeAt: i.madeAt,
    checks: [...i.hits.keys()].sort(),
    files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([f, s]) => [f, [...s].sort()])),
    dynamic: [...dynamic].sort(),
    selectedRuns: 0
  };
}

export type Selection = { all: true; why: string } | { all: false; checks: string[]; why: string };

export interface SelectInput {
  /** Checks of the active promises. */
  active: string[];
  coverage: Coverage | null;
  tree: string | null;
  /** Paths that differ between that tree and now, or null if git can't say. */
  changedSince: (tree: string) => string[] | null;
  now: number;
}

/**
 * Which checks this tree needs. Every doubt answers "all of them": the cost
 * of a needless full run is a few seconds, the cost of a skipped broken
 * promise is the whole point of the tool. The diff is taken from the map's
 * tree (the last full green run), so changes add up across partial runs
 * instead of each one being judged alone.
 */
export function selectChecks(i: SelectInput): Selection {
  const all = (why: string): Selection => ({ all: true, why });
  const cov = i.coverage;
  if (i.tree === null) return all("not a git repository");
  if (!cov) return all("no map of what each promise loads yet");
  if (cov.selectedRuns >= FULL_EVERY_RUNS) return all(`${FULL_EVERY_RUNS} partial runs since the last full one`);
  const age = i.now - Date.parse(cov.madeAt);
  if (!(age >= 0 && age <= FULL_EVERY_MS)) return all("the map is more than a day old");
  if (!i.active.every((c) => cov.checks.includes(c))) return all("the promises or their checks changed");
  const changed = i.changedSince(cov.tree);
  if (!changed || changed.length === 0) return all("can't tell what changed");
  if (changed.some((f) => f === STATE_DIR || f.startsWith(`${STATE_DIR}/`))) return all("the promises or their checks changed");
  const unmapped = changed.find((f) => !cov.files[f]);
  if (unmapped) return all(`${unmapped} isn't served as-is to any check`);

  const wanted = new Set([...cov.dynamic, ...changed.flatMap((f) => cov.files[f]!)]);
  const checks = i.active.filter((c) => wanted.has(c));
  if (checks.length === 0 || checks.length === i.active.length) return all("every promise loads what changed");
  const shown = changed.length > 3 ? `${changed.slice(0, 3).join(", ")} and ${changed.length - 3} more` : changed.join(", ");
  return { all: false, checks, why: `only ${shown} changed` };
}
