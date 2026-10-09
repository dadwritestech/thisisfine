/**
 * The camera both demo films share: a Chromium page on stage.html, a frame
 * per snap, and the GIF encoder. What's on stage is each film's business.
 *
 * Rendering uses playwright-core at the version thisisfine pins, installed into
 * .e2e-out/playwright, so the repo itself gains no dependencies.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PLAYWRIGHT_VERSION } from "../../src/types.ts";
import { encodeGif } from "./gif.ts";
import { decodePng } from "./png.ts";

export const ROOT = resolve(import.meta.dirname, "../..");
const PW = join(ROOT, ".e2e-out", "playwright");
const W = 960, H = 600;

interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<A>(fn: (arg: A) => unknown, arg: A): Promise<unknown>;
  screenshot(opts: { type: "png" }): Promise<Buffer>;
}

export const mug = `<svg><use href="#mug"/></svg>`;
export const wordmark = `<div class="big">this<span>is</span>fine</div>`;
export const installCard = `${mug}${wordmark}<p>Promises your coding agent can't quietly break.</p>
  <code>/plugin marketplace add dadwritestech/thisisfine\n/plugin install thisisfine@thisisfine</code>`;

/** Opens the stage; returns the film's verbs and `wrap(gifPath, framesDir)` to encode what was shot. */
export async function openFilm() {
  const core = join(PW, "node_modules", "playwright-core");
  if (!existsSync(core)) {
    console.log(`Installing playwright-core ${PLAYWRIGHT_VERSION} into ${PW}...`);
    const npm = spawnSync(`npm install --prefix "${PW}" --no-audit --no-fund --loglevel=error playwright-core@${PLAYWRIGHT_VERSION}`, { shell: true, stdio: "inherit" });
    if (npm.status !== 0) throw new Error("npm install playwright-core failed");
  }
  if (spawnSync(process.execPath, [join(core, "cli.js"), "install", "chromium"], { stdio: "inherit" }).status !== 0) {
    throw new Error("Playwright couldn't install Chromium");
  }
  const { chromium } = await import(pathToFileURL(join(core, "index.mjs")).href) as {
    chromium: { launch(): Promise<{ newPage(o: object): Promise<Page>; close(): Promise<void> }> }
  };
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(import.meta.dirname, "stage.html")).href);

  // Each snap is one GIF frame; identical frames merge into one longer frame.
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

  async function wrap(gifPath: string, framesDir: string | null) {
    await browser.close();
    const gif = encodeGif(W, H, frames.length, (i) => ({ rgba: decodePng(frames[i]!.png).rgba, delayMs: frames[i]!.delayMs }));
    writeFileSync(gifPath, gif);
    if (framesDir) {
      rmSync(framesDir, { recursive: true, force: true }); mkdirSync(framesDir, { recursive: true });
      frames.forEach((f, i) => writeFileSync(join(framesDir, `${String(i).padStart(3, "0")}-${f.delayMs}ms.png`), f.png));
      console.log(`Frames in ${framesDir}`);
    }
    const secs = frames.reduce((n, f) => n + f.delayMs, 0) / 1000;
    console.log(`Wrote ${gifPath}: ${frames.length} frames, ${secs.toFixed(1)}s, ${(gif.length / 1024 / 1024).toFixed(2)} MB`);
  }

  return { snap, stage, line, caption, scene, type, stream, hook, diff, card, wrap };
}
