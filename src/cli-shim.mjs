// The cli under test, as a check sees it. A check runs
//   [...THISISFINE_CLI, ...its own args]
// and this script runs the configured cli with those args:
//  - in a scratch working directory (THISISFINE_WORK),
//  - with HOME and every per-user config dir pointing into scratch, so a tool
//    that writes ~/.toolrc can't touch the human's real one or remember
//    anything between runs,
//  - passing stdin, stdout, stderr and the exit code straight through,
//  - and, during proofs, appending what it ran and printed to THISISFINE_EVIDENCE.
// Plain JS on purpose: it runs as its own process, once per call.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const EVIDENCE_MAX = 2000;

const argv = JSON.parse(process.env.THISISFINE_CLI_ARGV || "[]");
if (!Array.isArray(argv) || argv.length === 0) {
  process.stderr.write("thisisfine: no cli configured (set \"cli\" in .thisisfine/config.json)\n");
  process.exit(127);
}
const args = process.argv.slice(2);
const work = process.env.THISISFINE_WORK || join(mkdtempSync(join(tmpdir(), "thisisfine-cli-")), "work");
const home = join(dirname(work), "home");
for (const d of [work, home, join(home, ".config"), join(home, ".local", "share"), join(home, "AppData", "Roaming"), join(home, "AppData", "Local")]) {
  mkdirSync(d, { recursive: true });
}

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  ...(process.platform === "win32" ? { APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") } : {})
};
for (const k of Object.keys(env)) if (k.startsWith("THISISFINE_")) delete env[k];

const shown = (a) => (a === "" ? `""` : /[\s"'$`\\]/.test(a) ? (a.includes(`"`) ? `'${a}'` : `"${a}"`) : a);
const display = `$ ${process.env.THISISFINE_CLI_DISPLAY || argv.map(shown).join(" ")}${args.length ? " " + args.map(shown).join(" ") : ""}`;

let captured = "";
let dropped = 0;
const capture = (chunk) => {
  const text = chunk.toString("utf8");
  const room = EVIDENCE_MAX - captured.length;
  if (room > 0) captured += text.slice(0, room);
  dropped += Math.max(0, Buffer.byteLength(text) - Math.max(0, room));
};

function record(exit) {
  const file = process.env.THISISFINE_EVIDENCE;
  if (!file) return;
  const more = dropped > 0 ? `\n… (${dropped} more bytes)` : "";
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${display}\n${captured.replace(/\s+$/, "")}${more}${captured || more ? "\n" : ""}[exit ${exit}]\n\n`);
  } catch {
    // evidence is a courtesy; never fail the check over it
  }
}

const child = spawn(argv[0], [...argv.slice(1), ...args], { cwd: work, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
process.stdin.on("error", () => {});
child.stdin.on("error", () => {});
process.stdin.pipe(child.stdin);
child.stdout.on("data", (c) => (process.stdout.write(c), capture(c)));
child.stderr.on("data", (c) => (process.stderr.write(c), capture(c)));
child.on("error", (err) => {
  const message = `couldn't start ${argv[0]}: ${err.message}`;
  process.stderr.write(`thisisfine: ${message}\n`);
  if (process.env.THISISFINE_SHIM_ERRORS) {
    try {
      mkdirSync(dirname(process.env.THISISFINE_SHIM_ERRORS), { recursive: true });
      appendFileSync(process.env.THISISFINE_SHIM_ERRORS, message + "\n");
    } catch {
      // nothing more to do
    }
  }
  record(127);
  process.exit(127);
});
child.on("close", (code, signal) => {
  const exit = code ?? (signal ? 128 : 1);
  record(signal ? `${exit} (${signal})` : exit);
  process.stdin.unpipe(child.stdin);
  process.stdin.destroy();
  process.exitCode = exit;
});
