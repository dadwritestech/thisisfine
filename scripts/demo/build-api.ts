/**
 * Films docs/img/demo-api.gif from a real end-to-end run of the Python API example.
 *
 *   npm run demo:api            # runs the API E2E (about 30 s, needs Python 3.9+), then renders
 *   npm run demo:api -- --reuse # renders from the last run in .e2e-out/demo-api
 *   add --frames to also keep every frame as a PNG in .e2e-out/demo-api/frames
 *
 * Every line of thisisfine output in the GIF is read from the files the E2E writes
 * (THISISFINE_E2E_OUT). What's staged is the framing around them: what the human
 * types, Claude's one-line narration, the diffs (the E2E's own edits to app.py, shown
 * as Claude making them), and the sabotage patch's file name (the E2E's is a temp
 * path). Run directories are shortened to "runs/…/", and the lock message stops after
 * its first sentence (the rest names the OS user's key file).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installCard, mug, openFilm, ROOT, wordmark } from "./film.ts";

const RUN = join(ROOT, ".e2e-out", "demo-api");
const GIF = join(ROOT, "docs", "img", "demo-api.gif");

// 1. A real run.
if (!process.argv.includes("--reuse") || !existsSync(join(RUN, "api-stop-fixed.json"))) {
  console.log("Running the API end-to-end test...");
  const e2e = spawnSync(process.execPath, ["--test", "--test-name-pattern", "Python API", "test/e2e-api-cli.test.ts"], {
    cwd: ROOT, stdio: "inherit", env: { ...process.env, THISISFINE_E2E: "1", THISISFINE_E2E_REQUIRE: "1", THISISFINE_E2E_OUT: RUN }
  });
  if (e2e.status !== 0) throw new Error("the end-to-end test failed, so there is nothing true to film");
}
const read = (file: string) => readFileSync(join(RUN, file), "utf8").trim();
const json = (file: string) => JSON.parse(read(file)) as Record<string, any>;
const shorten = (s: string) => s.replace(/\.thisisfine\/runs\/[^/\s]+\//g, ".thisisfine/runs/…/");

const proposeOut = shorten(read("api-propose.txt"));
const [proving, ...rest] = proposeOut.split("\n");
const [proof, question] = rest.join("\n").split(/\n\s*\nAsk the human exactly this[^\n]*\n/);
const check = /running (\S+) against/.exec(proving!)?.[1];
const sentence = /Lock in promise #\d+ "([^"]+)"/.exec(question ?? "")?.[1];
const note = /fails when sabotaged \(([^)]+)\)/.exec(proof ?? "")?.[1];
const locked = (json("api-locked.json").systemMessage as string).replace(/(\.)\s.*$/s, "$1");
const fine = json("api-stop-fine.json").systemMessage as string;
const broken = json("api-stop-broken.json");
const fixed = json("api-stop-fixed.json").systemMessage as string;
for (const [name, value] of Object.entries({ check, sentence, note, proof, question, locked, fine, broken: broken.reason, fixed })) {
  if (!value) throw new Error(`couldn't read ${name} from ${RUN}; did the E2E output format change?`);
}

// 2. The film.
const { snap, stage, line, caption, scene, type, stream, hook, card, wrap } = await openFilm();
await stage("title", "claude · ~/fine-notes-api");

const expiry = [`    if session["expires"] < time.time():`, `        return None, "token expired"`];

await card(`${mug}${wordmark}<p>Not just web pages. A real run of the example Python API, replayed by the end-to-end test.</p>`);
await snap(2400);

await scene("terminal");
await caption("<b>1</b> You report a bug in the API");
await snap(200);
await type("Expired tokens still get into GET /me. Fix it.");
await line("tool", "Update(app.py)");
for (const l of expiry) { await line("add", `+ ${l}`); await snap(160); }
await snap(300);
await line("claude", "Fixed. Writing a check, and a patch that undoes the fix, so thisisfine can prove it.");
await snap(500);
await line("tool", `Bash(thisisfine propose --sentence "${sentence}" --check ${check} --sabotage no-expiry.patch --sabotage-note "${note}")`);
await snap(900);
await caption("<b>2</b> Proven: what it sent, what came back, with and without the fix");
await stream("out", proof!, 140, "first");
await snap(800);
await stream("claude", question!.trim(), 120);
await snap(3000);

await stage("clear");
await caption("<b>3</b> You say yes. It's locked.");
await snap(300);
await type("y");
await hook("UserPromptSubmit", locked);
await snap(1400);
await hook("Stop", fine);
await snap(1800);

await stage("clear");
await caption("<b>4</b> Weeks later: “tidy up the auth code”");
await snap(300);
await type("Tidy up the auth code, please.");
await line("tool", "Update(app.py)");
for (const l of expiry) { await line("del", `- ${l}`); await snap(160); }
await snap(300);
await line("claude", "Done! session_for is simpler now.");
await snap(900);
await caption("<b>4</b> Claude tries to stop, and can't");
await stage("pin", await hook("Stop", broken.systemMessage, true));
await snap(700);
await line("dim", "Stop hook feedback:");
await stream("block", shorten(broken.reason), 50);
await snap(3400);

await stage("clear");
await caption("<b>5</b> So Claude fixes the app");
await line("claude", "Putting the expiry check back: expired tokens get a 401 again.");
await line("tool", "Update(app.py)");
for (const l of expiry) { await line("add", `+ ${l}`); await snap(160); }
await snap(400);
await hook("Stop", fixed);
await snap(2600);

await card(installCard);
await snap(3800);
await wrap(GIF, process.argv.includes("--frames") ? join(RUN, "frames") : null);
