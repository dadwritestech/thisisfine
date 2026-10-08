import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { startEvidenceProxy } from "../src/proxy.ts";
import { freePort } from "../src/launcher.ts";
import { tempDir } from "./helpers.ts";

async function app(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/login") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "token expired", got: JSON.parse(body || "{}") }));
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("y".repeat(100_000));
      } else if (req.url === "/gz") {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        res.end(gzipSync(JSON.stringify({ zipped: true })));
      } else if (req.url === "/host") {
        res.end(req.headers.host);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  server.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(d));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, server };
}

test("forwards requests untouched and writes readable evidence", async () => {
  const { url, server } = await app();
  const file = join(tempDir("tif-proxy-"), "evidence.txt");
  const proxy = await startEvidenceProxy(url, file);
  try {
    const r = await fetch(`${proxy.url}/login`, { method: "POST", body: JSON.stringify({ token: "old" }), headers: { "content-type": "application/json" } });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "token expired", got: { token: "old" } });
    const big = await fetch(`${proxy.url}/big`);
    assert.equal((await big.text()).length, 100_000, "big bodies stream through whole");
    const gz = await fetch(`${proxy.url}/gz`);
    assert.deepEqual(await gz.json(), { zipped: true });
    const host = await (await fetch(`${proxy.url}/host`)).text();
    assert.equal(host, new URL(proxy.url).host, "Host is kept, so the app builds links back through the proxy");
  } finally {
    await proxy.stop();
    server.close();
  }
  const evidence = readFileSync(file, "utf8");
  assert.match(evidence, /^POST \/login → 401$/m);
  assert.match(evidence, /^> \{\n>   "token": "old"\n> \}$/m, "JSON request bodies are pretty-printed");
  assert.match(evidence, /^<   "error": "token expired",$/m);
  assert.match(evidence, /^GET \/big → 200$/m);
  assert.match(evidence, /… \(\d+ more bytes\)/);
  assert.ok(evidence.length < 6000, `evidence is ${evidence.length} chars`);
  assert.match(evidence, /"zipped": true/, "compressed bodies are decoded for the evidence");
});

test("websocket upgrades pass through and are noted", async () => {
  const { url, server } = await app();
  const file = join(tempDir("tif-proxy-"), "evidence.txt");
  const proxy = await startEvidenceProxy(url, file);
  try {
    const { port } = new URL(proxy.url);
    const echoed = await new Promise<string>((resolve, reject) => {
      const s = connect(Number(port), "127.0.0.1", () => {
        s.write("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      });
      let got = "";
      s.on("data", (d) => {
        got += d;
        if (got.includes("101") && !got.includes("ping")) s.write("ping");
        if (got.includes("ping")) {
          s.destroy();
          resolve(got);
        }
      });
      s.on("error", reject);
    });
    assert.match(echoed, /101 Switching Protocols/);
  } finally {
    await proxy.stop();
    server.close();
  }
  assert.match(readFileSync(file, "utf8"), /^GET \/ws → upgraded$/m);
});

test("a dead app answers 502 and the attempt is still on record", async () => {
  const port = await freePort();
  const file = join(tempDir("tif-proxy-"), "evidence.txt");
  const proxy = await startEvidenceProxy(`http://127.0.0.1:${port}`, file);
  try {
    const r = await fetch(`${proxy.url}/health`);
    assert.equal(r.status, 502);
  } finally {
    await proxy.stop();
  }
  assert.match(readFileSync(file, "utf8"), /^GET \/health → 502 \(the app didn't answer: .+\)$/m);
});
