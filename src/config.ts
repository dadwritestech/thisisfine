import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { splitCommand } from "./boundary.ts";
import { GO_MOD, GO_TIF, PY_HELPER, PY_REQUIREMENTS, PYTEST_INI, TIF_TS } from "./kits.ts";
import type { Config } from "./types.ts";
import { PLAYWRIGHT_VERSION, STATE_DIR } from "./types.ts";

export const DEFAULTS: Omit<Config, "start" | "cli" | "build"> = {
  readyPath: "/",
  readyTimeoutMs: 60_000,
  checkTimeoutMs: 30_000,
  copy: [".env", ".env.local", ".env.development", ".env.development.local"]
};

export function configPath(root: string): string {
  return join(root, STATE_DIR, "config.json");
}

interface PackageJson {
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** Which languages the project is written in, which decides the runners `init` sets up. */
export interface Stacks {
  node: boolean;
  python: boolean;
  go: boolean;
}

export function detectStacks(root: string): Stacks {
  const has = (f: string) => existsSync(join(root, f));
  return {
    node: has("package.json"),
    python: has("pyproject.toml") || has("requirements.txt") || has("setup.py") || has("manage.py"),
    go: has("go.mod")
  };
}

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/** A Go main package to build: `cmd/<name>/main.go` first, then `main.go` at the root. */
function goMain(root: string): { pkg: string; name: string } | null {
  const cmd = join(root, "cmd");
  if (existsSync(cmd)) {
    for (const name of readdirSync(cmd).sort()) {
      if (existsSync(join(cmd, name, "main.go"))) return { pkg: `./cmd/${name}`, name };
    }
  }
  if (existsSync(join(root, "main.go"))) {
    const mod = /^module\s+(\S+)/m.exec(read(join(root, "go.mod")))?.[1] ?? "app";
    return { pkg: ".", name: mod.split("/").pop()!.replace(/[^\w.-]/g, "") || "app" };
  }
  return null;
}

/**
 * A best guess at the app's edges: how to start it on a port of our
 * choosing, and which command is the cli. Framework CLIs are called directly
 * when we can, because `npm run dev` often pins a port in the script itself,
 * and two apps on one port is the one thing a proof can't survive.
 * `detected` is printed by `init` so the guess is never silent.
 */
export function detectConfig(root: string): { config: Config; detected: string; known: boolean } {
  let pkg: PackageJson = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
  } catch {
    // no package.json: fall through to the other stacks
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts ?? {};
  const pick = (edges: Pick<Config, "start" | "cli" | "build">, detected: string, known = true) => ({ config: { ...edges, ...DEFAULTS }, detected, known });
  if (deps.next) return pick({ start: "npx next dev -p {port}" }, "Next.js");
  if (deps.vite) return pick({ start: "npx vite --port {port} --strictPort" }, "Vite");

  const stacks = detectStacks(root);
  if (stacks.go) {
    const main = goMain(root);
    if (main) {
      return pick(
        { build: `go build -o .thisisfine/bin/${main.name}{exe} ${main.pkg}`, cli: `{app}/.thisisfine/bin/${main.name}{exe}` },
        `Go, built from ${main.pkg} and checked as a cli (if it's a server, replace "cli" with "start" and a {port})`
      );
    }
    return pick({ cli: "go run ." }, `Go, but no main package found: edit "cli" (or "start") in ${STATE_DIR}/config.json`, false);
  }
  if (stacks.python) {
    const pyproject = read(join(root, "pyproject.toml"));
    const deps = `${pyproject}\n${read(join(root, "requirements.txt"))}`.toLowerCase();
    if (existsSync(join(root, "manage.py"))) return pick({ start: "python manage.py runserver 127.0.0.1:{port} --noreload" }, "Django");
    if (/\bfastapi\b/.test(deps)) return pick({ start: "python -m uvicorn main:app --port {port}" }, `FastAPI, guessing the app is main:app: edit "start" in ${STATE_DIR}/config.json if not`, false);
    if (/\bflask\b/.test(deps)) return pick({ start: "python -m flask run --port {port}" }, "Flask");
    const script = /\[project\.scripts\][^\[]*?^\s*["']?([\w.-]+)["']?\s*=/m.exec(pyproject)?.[1];
    if (script) return pick({ cli: script }, `the "${script}" script from pyproject.toml, checked as a cli (install it first: pip install -e .)`);
    return pick({ cli: "python main.py" }, `Python, but nothing recognisable: edit "cli" (or "start") in ${STATE_DIR}/config.json`, false);
  }

  if (scripts.dev) return pick({ start: "npm run dev" }, 'the "dev" script (PORT is set; make sure the app reads it)');
  if (scripts.start) return pick({ start: "npm start" }, 'the "start" script (PORT is set; make sure the app reads it)');
  const bin = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {})[0];
  if (bin) return pick({ cli: `node ${bin}` }, `the package's bin (${bin}), checked as a cli`);
  return pick({ start: "npm start" }, `nothing recognisable: set "start" or "cli" in ${STATE_DIR}/config.json`, false);
}

export function loadConfig(root: string): Config {
  const path = configPath(root);
  if (!existsSync(path)) throw new Error(`No ${STATE_DIR}/config.json here. Run "thisisfine init" in the project root first.`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  const config = { ...DEFAULTS, ...raw } as Config;
  for (const k of ["start", "cli", "build"] as const) {
    const v: unknown = config[k];
    if (v !== undefined && (typeof v !== "string" || v.trim() === "")) throw new Error(`${path}: "${k}" must be a command string`);
  }
  if (!config.start && !config.cli) throw new Error(`${path}: set "start" (the server to check) or "cli" (the command to check), or both`);
  if (config.cli) splitCommand(config.cli);
  if (typeof config.readyPath !== "string" || !config.readyPath.startsWith("/")) throw new Error(`${path}: "readyPath" must start with /`);
  for (const k of ["readyTimeoutMs", "checkTimeoutMs"] as const) {
    if (!Number.isFinite(config[k]) || config[k] <= 0) throw new Error(`${path}: "${k}" must be a positive number`);
  }
  if (!Array.isArray(config.copy) || !config.copy.every((c) => typeof c === "string")) throw new Error(`${path}: "copy" must be a list of paths`);
  return config;
}

const PLAYWRIGHT_CONFIG = `// Generated by thisisfine. Every run-specific value arrives through the
// environment, so this one file serves proofs and gates alike.
import { defineConfig } from "@playwright/test";

const env = process.env;
// Recorded runs: one project per check, each behind its own proxy, so the
// port a request arrives on says which check made it.
const proxies = JSON.parse(env.THISISFINE_PROXIES || "null");
const sep = "[\\\\\\\\/]";
export default defineConfig({
  ...(proxies ? {
    projects: Object.entries(proxies).map(([check, port]) => ({
      name: check,
      testMatch: new RegExp(sep + check.split("/").map((part) => part.replace(/\\W/g, "\\\\$&")).join(sep) + "$"),
      use: { proxy: { server: "http://127.0.0.1:" + port } }
    }))
  } : {}),
  testDir: "./checks",
  testMatch: "**/*.spec.ts",
  timeout: Number(env.THISISFINE_TIMEOUT || 30000),
  retries: Number(env.THISISFINE_RETRIES || 0),
  workers: 2,
  outputDir: env.THISISFINE_OUTPUT_DIR || "./runs/last/artifacts",
  reporter: [["json", { outputFile: env.THISISFINE_REPORT || "./runs/last/report.json" }]],
  use: {
    baseURL: env.THISISFINE_BASE_URL,
    browserName: "chromium",
    screenshot: env.THISISFINE_SCREENSHOT === "on" ? "on" : "only-on-failure",
    trace: "off"
  }
});
`;

const GITIGNORE = `runs/
node_modules/
.venv/
bin/
__pycache__/
.pytest_cache/
`;

/**
 * Lays out `.thisisfine/`. Playwright gets its own package.json in there so
 * the user's dependency tree is never touched; the version is pinned so a
 * check that passed yesterday runs in the same browser today. Python and Go
 * checks get their helper and their own project files (pytest.ini, go.mod)
 * for the same reason. The venv itself is `init`'s job: it needs a network.
 */
export function writeScaffold(root: string, config: Config, stacks: Stacks = detectStacks(root)): string[] {
  const dir = join(root, STATE_DIR);
  mkdirSync(join(dir, "checks"), { recursive: true });
  const written: string[] = [];
  const write = (name: string, content: string, overwrite: boolean) => {
    const path = join(dir, name);
    if (!overwrite && existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written.push(`${STATE_DIR}/${name}`);
  };
  write("config.json", JSON.stringify(config, null, 2) + "\n", false);
  write("playwright.config.mjs", PLAYWRIGHT_CONFIG, true);
  write("package.json", JSON.stringify({
    name: "thisisfine-checks", private: true, type: "module",
    devDependencies: { "@playwright/test": PLAYWRIGHT_VERSION }
  }, null, 2) + "\n", true);
  write("tif.ts", TIF_TS, true);
  if (stacks.python) {
    write("thisisfine_check.py", PY_HELPER, true);
    write("pytest.ini", PYTEST_INI, true);
    write("requirements.txt", PY_REQUIREMENTS, true);
  }
  if (stacks.go) {
    write("go.mod", GO_MOD, true);
    write("tif/tif.go", GO_TIF, true);
  }
  write(".gitignore", GITIGNORE, true);
  write("checks/.gitkeep", "", false);
  return written;
}
