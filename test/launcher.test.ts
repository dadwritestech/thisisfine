import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { probe, startApp } from "../src/launcher.ts";
import { put, tempDir } from "./helpers.ts";

const SERVER = `import http from "node:http";
const port = Number(process.argv[2] || process.env.PORT);
const status = Number(process.env.STATUS || 200);
http.createServer((q, s) => { s.statusCode = status; s.end("hello from " + port); }).listen(port);
`;

function app(): string {
  const dir = tempDir();
  put(dir, "server.mjs", SERVER);
  return dir;
}

test("starts with {port} substituted, answers, and stops for good", async () => {
  const dir = app();
  const running = await startApp({ cwd: dir, start: "node server.mjs {port}", readyPath: "/", readyTimeoutMs: 15000, logPath: join(dir, "app.log") });
  assert.equal(await probe(running.url + "/"), 200);
  await running.stop();
  assert.equal(await probe(running.url + "/"), null);
});

test("PORT env works for apps that read it", async () => {
  const dir = app();
  const running = await startApp({ cwd: dir, start: "node server.mjs", readyPath: "/", readyTimeoutMs: 15000, logPath: join(dir, "app.log") });
  try {
    const body = await (await fetch(running.url)).text();
    assert.equal(body, `hello from ${running.port}`);
  } finally {
    await running.stop();
  }
});

test("a command that exits early fails with its log tail", async () => {
  const dir = tempDir();
  put(dir, "crash.mjs", "console.log('boom: missing env');\nprocess.exit(3);\n");
  await assert.rejects(
    startApp({ cwd: dir, start: "node crash.mjs", readyPath: "/", readyTimeoutMs: 15000, logPath: join(dir, "app.log") }),
    (err: Error) => /exited/.test(err.message) && /boom: missing env/.test(err.message)
  );
});

test("an app that only answers 5xx never counts as booted", async () => {
  const dir = app();
  await assert.rejects(
    startApp({ cwd: dir, start: "node server.mjs {port}", readyPath: "/", readyTimeoutMs: 1500, logPath: join(dir, "app.log"), env: { STATUS: "500" } }),
    /did not answer .* within 1.5s/
  );
});
