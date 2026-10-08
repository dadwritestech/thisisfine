import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { STATE_DIR } from "./types.ts";

/**
 * Which runner a check belongs to, decided by its path alone so the gate,
 * the guard and `propose` always agree:
 *   .thisisfine/checks/<name>.spec.ts          Playwright Test
 *   .thisisfine/checks/<name>.py               pytest
 *   .thisisfine/checks/<name>/check_test.go    go test (a package each, so one
 *                                              that won't compile breaks only itself)
 */
export type CheckKind = "playwright" | "pytest" | "go";

const CHECKS = `${STATE_DIR}/checks/`;
/** Files in checks/ that pytest would treat as something other than a check. */
const PY_RESERVED = new Set(["conftest.py", "thisisfine_check.py", "__init__.py"]);

export function checkKind(check: string): CheckKind | null {
  if (!check.startsWith(CHECKS)) return null;
  const rest = check.slice(CHECKS.length);
  if (rest.endsWith(".spec.ts")) return "playwright";
  if (/^[^/]+\.py$/.test(rest)) return "pytest";
  if (/^[^/]+\/check_test\.go$/.test(rest)) return "go";
  return null;
}

/** Null when `check` (root-relative, forward slashes) can be a promise's check. */
export function checkPathProblem(check: string): string | null {
  if (!check.startsWith(CHECKS) || check.includes("/../")) return `the check must be inside ${CHECKS}`;
  const name = check.slice(check.lastIndexOf("/") + 1);
  if (PY_RESERVED.has(name)) {
    return name === "conftest.py"
      ? "conftest.py would change every Python check at once; put fixtures in the check itself"
      : `${name} is thisisfine's helper module, not a check`;
  }
  if (checkKind(check)) return null;
  return `a check is ${CHECKS}<name>.spec.ts (Playwright), ${CHECKS}<name>.py (pytest) or ${CHECKS}<name>/check_test.go (Go)`;
}

// ── black-box rule ──────────────────────────────────────────────────────

/** Top-level Python names that are the project's own code. */
function pythonProjectNames(root: string): Set<string> {
  const names = new Set<string>();
  const scan = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith(".") || e === STATE_DIR || e === "node_modules" || e === "venv") continue;
      if (e.endsWith(".py")) names.add(e.slice(0, -3));
      else if (existsSync(join(dir, e, "__init__.py"))) names.add(e);
    }
  };
  scan(root);
  if (existsSync(join(root, "src"))) {
    names.add("src");
    scan(join(root, "src"));
  }
  try {
    const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(readFileSync(join(root, "pyproject.toml"), "utf8"))?.[1];
    if (name) names.add(name.toLowerCase().replace(/[-.]+/g, "_"));
  } catch {
    // no pyproject.toml
  }
  names.delete("setup");
  names.delete("conftest");
  return names;
}

function pythonViolations(root: string, source: string): string[] {
  const own = pythonProjectNames(root);
  const found: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const from = /^from\s+([\w.]+)\s+import\b/.exec(line);
    const imp = /^import\s+(.+)$/.exec(line);
    const modules = from ? [from[1]!] : imp ? imp[1]!.split(",").map((m) => m.trim().split(/\s+/)[0]!) : [];
    if (modules.some((m) => own.has(m.split(".")[0]!))) {
      found.push(line);
      continue;
    }
    if (/\bsys\.path\b|\b__import__\s*\(|\bimportlib\.(import_module|util)\b|\brunpy\b/.test(line)) found.push(line);
  }
  return found;
}

function goViolations(root: string, source: string): string[] {
  let module: string | undefined;
  try {
    module = /^module\s+(\S+)/m.exec(readFileSync(join(root, "go.mod"), "utf8"))?.[1];
  } catch {
    return [];
  }
  if (!module) return [];
  const specs: string[] = [];
  const code = source.replace(/\/\/.*$/gm, "");
  for (const block of code.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) {
    for (const l of block[1]!.split(/\r?\n/)) if (l.trim()) specs.push(l.trim());
  }
  for (const single of code.matchAll(/^import\s+((?:[\w.]+\s+)?"[^"]+")/gm)) specs.push(single[1]!.trim());
  return specs.filter((s) => {
    const path = /"([^"]+)"/.exec(s)?.[1];
    return path !== undefined && (path === module || path.startsWith(`${module}/`));
  });
}

function jsViolations(root: string, check: string, source: string): string[] {
  const stateDir = resolve(root, STATE_DIR);
  const from = dirname(resolve(root, check));
  const found: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("//")) continue;
    const specs = [...line.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
    const leaves = specs.some((s) => {
      if (!(s.startsWith(".") || s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s))) return false;
      const rel = relative(stateDir, resolve(from, s));
      return rel.startsWith("..") || isAbsolute(rel);
    });
    if (leaves) found.push(line);
  }
  return found;
}

/**
 * The lines of a check that reach into the app's own code. A promise is
 * about what the app does from the outside (HTTP, the CLI, the browser), so
 * a check that imports a module would keep passing while the app it ships
 * is broken, and break on harmless refactors. Static and conservative: it
 * flags only what it can name, and the reason is printed so the agent can
 * rewrite the check rather than fight the rule.
 */
export function projectImports(root: string, check: string, source: string): string[] {
  switch (checkKind(check)) {
    case "pytest": return pythonViolations(root, source);
    case "go": return goViolations(root, source);
    case "playwright": return jsViolations(root, check, source);
    default: return [];
  }
}
