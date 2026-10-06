/**
 * Films docs/img/demo.gif from a real end-to-end run.
 *
 *   npm run demo            # runs the E2E (about a minute), then renders
 *   npm run demo -- --reuse # renders from the last run in .e2e-out/demo
 *   add --frames to also keep every frame as a PNG in .e2e-out/demo/frames
 *
 * Every line of thisisfine output in the GIF is read from the files the E2E writes
 * (THISISFINE_E2E_OUT), and the shop frames are its screenshots. What's staged is the
 * framing around them: what the human types, Claude's one-line narration, and the
 * order of the guard scene (the E2E tries the edit before the break; its output
 * doesn't depend on that). Long run directories are shortened to "runs/…/", as in the README.
 *
 * Rendering uses playwright-core at the version thisisfine pins, installed into
 * .e2e-out/playwright, so the repo itself gains no dependencies.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PLAYWRIGHT_VERSION } from "../../src/types.ts";
import { encodeGif } from "./gif.ts";
import { decodePng } from "./png.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const RUN = join(ROOT, ".e2e-out", "demo");
const PW = join(ROOT, ".e2e-out", "playwright");
const GIF = join(ROOT, "docs", "img", "demo.gif");
const W = 960, H = 600;

// 1. A real run.
if (!process.argv.includes("--reuse") || !existsSync(join(RUN, "07-hook-stop-fixed.txt"))) {
  console.log("Running the end-to-end test...");
  const e2e = spawnSync(process.execPath, ["--test", "test/e2e.test.ts"], {
    cwd: ROOT, stdio: "inherit", env: { ...process.env, THISISFINE_E2E: "1", THISISFINE_E2E_OUT: RUN }
  });
  if (e2e.status !== 0) throw new Error("the end-to-end test failed, so there is nothing true to film");
}
const raw = (step: string) => readFileSync(join(RUN, `${step}.txt`), "utf8");
/** Output of a step without the "$ command" and "[exit …]" header lines. */
const output = (step: string) => raw(step).split("\n").slice(2).join("\n").trim();
const json = (step: string) => JSON.parse(output(step)) as Record<string, any>;
const shorten = (s: string) => s.replace(/\.thisisfine\/runs\/[^\s,)]+\/([^/\s,)]+\.png)/g, ".thisisfine/runs/…/$1");

const proposeCmd = raw("02-propose").split("\n")[0]!;
const [, sentence, check] = /--sentence (.+) --check (\S+)/.exec(proposeCmd)!;
const proposeOut = shorten(output("02-propose"));
const [proof, question] = proposeOut.split(/\n\s*\nAsk the human exactly this[^\n]*\n/);
const locked = json("03-hook-prompt-yes").systemMessage as string;
const fine = json("04-hook-stop-fine").systemMessage as string;
const denied = json("05-hook-guard-edit-check").hookSpecificOutput.permissionDecisionReason as string;
const broken = json("06-hook-stop-broken");
const fixed = json("07-hook-stop-fixed").systemMessage as string;
for (const [name, value] of Object.entries({ sentence, check, proof, question, locked, fine, denied, fixed })) {
  if (!value) throw new Error(`couldn't read ${name} from ${RUN}; did the E2E output format change?`);
}
const dataUrl = (file: string) => `data:image/png;base64,${readFileSync(join(RUN, file)).toString("base64")}`;

// 2. A browser to film with.
const core = join(PW, "node_modules", "playwright-core");
if (!existsSync(core)) {
  console.log(`Installing playwright-core ${PLAYWRIGHT_VERSION} into ${PW}...`);
  const npm = spawnSync(`npm install --prefix "${PW}" --no-audit --no-fund --loglevel=error playwright-core@${PLAYWRIGHT_VERSION}`, { shell: true, stdio: "inherit" });
  if (npm.status !== 0) throw new Error("npm install playwright-core failed");
}
if (spawnSync(process.execPath, [join(core, "cli.js"), "install", "chromium"], { stdio: "inherit" }).status !== 0) {
  throw new Error("Playwright couldn't install Chromium");
}
interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<A>(fn: (arg: A) => unknown, arg: A): Promise<unknown>;
  screenshot(opts: { type: "png" }): Promise<Buffer>;
}
const { chromium } = await import(pathToFileURL(join(core, "index.mjs")).href) as {
  chromium: { launch(): Promise<{ newPage(o: object): Promise<Page>; close(): Promise<void> }> }
};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(import.meta.dirname, "stage.html")).href);

// 3. The film. Each snap is one GIF frame; identical frames merge into one longer frame.
const frames: { png: Buffer; delayMs: number }[] = [];
async function snap(ms: number) {
  const png = await page.screenshot({ type: "png" });
  const last = frames.at(-1);
  if (last && last.png.equals(png)) last.delayMs += ms;
  else frames.push({ png, delayMs: ms });
}
/** Call a function of window.stage in stage.html. */
const stage = (fn: string, ...args: unknown[]) =>
  page.evaluate(([fn, args]) => (window as any).stage[fn as string](...(args as unknown[])), [fn, args] as const) as Promise<any>;
const line = (cls: string, parts: [cls: string, text: string][] | string) => stage("line", cls, parts) as Promise<number>;
const caption = (html: string) => stage("caption", html);
const scene = (id: string, flames = false) => stage("scene", id, flames);

async function type(text: string) {
  for (let i = 2; i < text.length + 2; i += 2) { await stage("typing", text.slice(0, i), false); await snap(45); }
  await stage("typing", text, true);
  await snap(350);
}
/** Reveal output a line at a time, the way it streams in. */
async function stream(cls: string, text: string, ms = 55, first = "") {
  for (const [i, l] of text.split("\n").entries()) {
    await line(`${cls}${i === 0 && first ? ` ${first}` : ""}`, l);
    await snap(ms);
  }
}
async function hook(who: string, message: string, bad = false) {
  const at = await line(`hook${bad ? " bad" : ""}`, [["who", who], ["", message]]);
  await snap(120);
  return at;
}
async function diff(from: string, to: string) {
  await line("del", `- ${from}`); await snap(140);
  await line("add", `+ ${to}`); await snap(500);
}
async function card(html: string) {
  await scene("card", true);
  await stage("card", html);
  await caption("");
}
async function shop(file: string, verdict: string, good: boolean) {
  await scene("browser");
  await stage("shop", dataUrl(file), verdict, good);
}

const badgeLine = `document.querySelector("[data-testid=cart-count]").textContent =`;
const mug = `<svg><use href="#mug"/></svg>`;
const wordmark = `<div class="big">this<span>is</span>fine</div>`;

await card(`${mug}${wordmark}<p>A real run of the example shop, replayed by the end-to-end test in a real browser.</p>`);
await snap(2200);

await scene("terminal");
await caption("<b>1</b> You ask for a cart badge");
await snap(200);
await type("Add a badge to the cart link that shows how many items are in it.");
await line("claude", "Added the badge. Writing a check and asking thisisfine to prove it.");
await snap(500);
await line("tool", `Bash(thisisfine propose --sentence "${sentence}" --check ${check})`);
await snap(900);
await stream("out", proof!, 160, "first");
await snap(500);
await stream("claude", question!.trim(), 120);
await snap(2200);

await shop("badge-works.png", "Badge: 2 ✔", true);
await caption("<b>2</b> The check passes in a real browser");
await snap(2600);

await scene("terminal");
await caption("<b>3</b> You say yes. It's locked.");
await snap(300);
await type("y, perfect");
await hook("UserPromptSubmit", locked);
await snap(1400);
await caption("<b>3</b> Every turn ends with…");
await hook("Stop", fine);
await snap(1800);

await stage("clear");
await caption("<b>4</b> Weeks later: “a small cleanup”");
await snap(300);
await type("Small cleanup of the cart code, please.");
await line("tool", "Update(public/app.js)");
await diff(`${badgeLine} String(cart.length);`, `${badgeLine} String(new Set(cart).size);`);
await line("claude", "Done! The cart code is tidier.");
await snap(900);
await caption("<b>4</b> Claude tries to stop, and can't");
// Pin the 🔥 line to the top: the failure that matters stays in view, the call log overflows below.
await stage("pin", await hook("Stop", broken.systemMessage, true));
await snap(700);
await line("dim", "Stop hook feedback:");
await stream("block", shorten(broken.reason), 50);
await snap(3000);

await shop("badge-broken.png", "Badge: 1 ✘  (you said 2)", false);
await caption("<b>5</b> What the check saw");
await snap(2600);

await scene("terminal");
await stage("clear");
await caption("<b>6</b> Editing the check is refused");
await line("hook bad", [["who", "Stop"], ["", broken.systemMessage]]);
await snap(600);
await line("claude", "I'll update the check to expect 1.");
await snap(500);
await line("tool", `Update(${check})`);
await snap(400);
await stream("out", `PreToolUse hook denied: ${denied}`, 55, "first");
await snap(2600);
await caption("<b>7</b> So Claude fixes the app");
await line("claude", "Fixing the app instead: the badge counts items again.");
await line("tool", "Update(public/app.js)");
await diff(`${badgeLine} String(new Set(cart).size);`, `${badgeLine} String(cart.length);`);
await hook("Stop", fixed);
await snap(2600);

await card(`${mug}${wordmark}<p>Promises your coding agent can't quietly break.</p>
  <code>/plugin marketplace add dadwritestech/thisisfine\n/plugin install thisisfine@thisisfine</code>`);
await snap(3800);
await browser.close();

// 4. Encode.
const gif = encodeGif(W, H, frames.length, (i) => ({ rgba: decodePng(frames[i]!.png).rgba, delayMs: frames[i]!.delayMs }));
writeFileSync(GIF, gif);
if (process.argv.includes("--frames")) {
  const dir = join(RUN, "frames");
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
  frames.forEach((f, i) => writeFileSync(join(dir, `${String(i).padStart(3, "0")}-${f.delayMs}ms.png`), f.png));
  console.log(`Frames in ${dir}`);
}
const secs = frames.reduce((n, f) => n + f.delayMs, 0) / 1000;
console.log(`Wrote ${GIF}: ${frames.length} frames, ${secs.toFixed(1)}s, ${(gif.length / 1024 / 1024).toFixed(2)} MB`);
