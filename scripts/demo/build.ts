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
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installCard, mug, openFilm, ROOT, wordmark } from "./film.ts";

const RUN = join(ROOT, ".e2e-out", "demo");
const GIF = join(ROOT, "docs", "img", "demo.gif");

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

// 2. The film.
const { snap, stage, line, caption, scene, type, stream, hook, diff, card, wrap } = await openFilm();
async function shop(file: string, verdict: string, good: boolean) {
  await scene("browser");
  await stage("shop", dataUrl(file), verdict, good);
}

const badgeLine = `document.querySelector("[data-testid=cart-count]").textContent =`;

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

await card(installCard);
await snap(3800);
await wrap(GIF, process.argv.includes("--frames") ? join(RUN, "frames") : null);
