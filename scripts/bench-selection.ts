/**
 * Does running only the affected promises actually save time?
 *
 *   node scripts/bench-selection.ts [rounds]
 *
 * Builds two throwaway projects (the shipped examples/cart, and the same shop
 * with a second page that only some promises visit), locks four promises in
 * each through the real CLI, then times the Stop hook after a one-file edit
 * against a forced full run of the same tree. Real npm install, real browser;
 * takes a few minutes.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve("bin/thisisfine.mjs");
const ROUNDS = Number(process.argv[2] ?? 3);

const ADD = `page.getByRole("button", { name: "Add House blend to cart" })`;
const CHECKS: Record<string, string> = {
  "1-badge": `await page.goto("/"); const add = ${ADD}; await add.click(); await add.click(); await expect(page.getByTestId("cart-count")).toHaveText("2");`,
  "2-menu": `await page.goto("/"); await expect(${ADD}).toBeVisible();`,
  "3-about-title": `await page.goto("/about.html"); await expect(page.getByRole("heading", { name: "About Fine Coffee Co." })).toBeVisible();`,
  "4-about-hours": `await page.goto("/about.html"); await page.getByRole("button", { name: "Show hours" }).click(); await expect(page.getByTestId("hours")).toHaveText("7am to 3pm");`
};
const ABOUT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>About</title></head><body>
<h1>About Fine Coffee Co.</h1><button id="hours-btn">Show hours</button><p data-testid="hours"></p>
<script src="/about.js"></script></body></html>
`;
const ABOUT_JS = `document.getElementById("hours-btn").addEventListener("click", () => { document.querySelector("[data-testid=hours]").textContent = "7am to 3pm"; });\n`;
const BADGE = [
  [`<a id="cart-link" href="#cart">Cart</a>`, `<a id="cart-link" href="#cart">Cart<span data-testid="cart-count">0</span></a>`]
] as const;

function sh(cwd: string, cmd: string, args: string[], env: Record<string, string> = {}, input = "") {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", input, env: { ...process.env, ...env }, timeout: 600_000 });
  if (r.status !== 0 && cmd === "git") throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r;
}

function build(multiPage: boolean) {
  const root = mkdtempSync(join(tmpdir(), "tif-bench-"));
  const home = mkdtempSync(join(tmpdir(), "tif-bench-home-"));
  cpSync(resolve("examples/cart"), root, { recursive: true });
  const edit = (rel: string, from: string, to: string) => writeFileSync(join(root, rel), readFileSync(join(root, rel), "utf8").replace(from, to));
  for (const [from, to] of BADGE) edit("public/index.html", from, to);
  edit("public/app.js", `cart.push(button.closest("[data-product]").dataset.product);`,
    `cart.push(button.closest("[data-product]").dataset.product);\n    document.querySelector("[data-testid=cart-count]").textContent = String(cart.length);`);
  if (multiPage) {
    writeFileSync(join(root, "public/about.html"), ABOUT_HTML);
    writeFileSync(join(root, "public/about.js"), ABOUT_JS);
  }
  const names = Object.keys(CHECKS).filter((n) => multiPage || !n.startsWith("3") && !n.startsWith("4"));
  const git = (...a: string[]) => sh(root, "git", ["-c", "user.name=bench", "-c", "user.email=b@b", ...a]);
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "shop");
  const env = { THISISFINE_HOME: home };
  const tif = (...a: string[]) => sh(root, process.execPath, [BIN, ...a], env);
  tif("init");
  git("add", "-A"); git("commit", "-qm", "init");
  mkdirSync(join(root, ".thisisfine/checks"), { recursive: true });
  for (const [i, n] of names.entries()) {
    const file = `.thisisfine/checks/${n}.spec.ts`;
    writeFileSync(join(root, file), `import { test, expect } from "@playwright/test";\ntest("${n}", async ({ page }) => { ${CHECKS[n]} });\n`);
    const r = tif("propose", "--sentence", `Promise ${i + 1}: ${n}`, "--check", file);
    if (r.status !== 0) throw new Error(`propose ${n}: ${r.stdout}${r.stderr}`);
  }
  const transcript = join(root, "..", `${root.split(/[\\/]/).pop()}-t.jsonl`);
  writeFileSync(transcript, JSON.stringify({ type: "user", promptId: "pr1", origin: { kind: "human" }, message: { role: "user", content: "y, perfect" } }) + "\n");
  const yes = sh(root, process.execPath, [BIN, "hook-prompt"], env, JSON.stringify({ session_id: "s", transcript_path: transcript, cwd: root, hook_event_name: "hook-prompt", prompt: "y, perfect", prompt_id: "pr1" }));
  if (!/locked/i.test(yes.stdout)) throw new Error(`lock: ${yes.stdout}${yes.stderr}`);
  git("add", "-A"); git("commit", "-qm", "promises");
  return {
    root, names,
    edit,
    stop() {
      const t = performance.now();
      const r = sh(root, process.execPath, [BIN, "hook-stop"], env, JSON.stringify({ session_id: "s", transcript_path: transcript, cwd: root, hook_event_name: "hook-stop" }));
      const json = JSON.parse(r.stdout || "{}") as { systemMessage?: string; decision?: string };
      return { secs: (performance.now() - t) / 1000, message: json.systemMessage ?? r.stdout.trim(), blocked: json.decision === "block" };
    },
    full() {
      const t = performance.now();
      const r = tif("check");
      return { secs: (performance.now() - t) / 1000, message: r.stdout.trim() };
    }
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const f = (n: number) => n.toFixed(1).padStart(5);
const rows: string[] = [];

for (const [label, multi] of [["examples/cart as shipped (4→2 promises, 1 page)", false], ["cart + an About page (4 promises, 2 pages)", true]] as const) {
  console.log(`\n== ${label}`);
  const p = build(multi);
  const first = p.stop();
  console.log(`first stop (full, records the map): ${f(first.secs)}s  ${first.message}`);
  const edits: [string, string, string][] = [
    ["public/style.css", "}", "}\n/* tweak */"],
    ["public/app.js", "cart.push(", "/* tweak */ cart.push("]
  ];
  if (multi) edits.push(["public/about.html", "<h1>", "<!-- tweak --><h1>"], ["public/about.js", "document.getElementById", "/* tweak */ document.getElementById"]);
  for (const [rel, from, to] of edits) {
    const sel: number[] = [], full: number[] = [];
    let message = "";
    for (let i = 0; i < ROUNDS; i++) {
      p.edit(rel, from, to.replace("tweak", `tweak${i}`));
      const s = p.stop();
      if (s.blocked) throw new Error(`blocked: ${s.message}`);
      sel.push(s.secs); message = s.message;
      full.push(p.full().secs);
    }
    console.log(`edit ${rel.padEnd(18)} selected ${f(mean(sel))}s  full ${f(mean(full))}s  → ${message}`);
    rows.push(`${label} | ${rel} | ${mean(sel).toFixed(1)} | ${mean(full).toFixed(1)}`);
  }
}
