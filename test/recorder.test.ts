import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { blobOf } from "../src/git.ts";
import { startRecorder } from "../src/recorder.ts";

const A = ".thisisfine/checks/1-a.spec.ts";
const B = ".thisisfine/checks/2-b.spec.ts";

async function app() {
  const srv = createServer((req, res) => {
    if (req.url === "/app.js") res.writeHead(200, { "content-type": "text/javascript" }).end("console.log(1)\n");
    else if (req.url === "/gz") res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync("zipped\n"));
    else if (req.url === "/echo" && req.method === "POST") req.pipe(res.writeHead(201));
    else res.writeHead(404).end("not found");
  });
  srv.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(d));
  });
  // closeAllConnections() skips upgraded sockets, so keep our own list
  const sockets = new Set<Socket>();
  srv.on("connection", (s: Socket) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { port: (srv.address() as AddressInfo).port, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(r); }) };
}

/** Asks the proxy for `url` the way a browser configured with it would. */
function viaProxy(proxyPort: number, url: string, method = "GET", body?: string): Promise<{ status: number; body: Buffer; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, method, path: url, headers: { host: new URL(url).host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("each check's proxy forwards requests untouched and records them under that check", async () => {
  const target = await app();
  const rec = await startRecorder([A, B]);
  try {
    const base = `http://localhost:${target.port}`;
    const js = await viaProxy(rec.ports[A]!, `${base}/app.js`);
    assert.equal(js.status, 200);
    assert.equal(js.body.toString(), "console.log(1)\n");
    const gz = await viaProxy(rec.ports[A]!, `${base}/gz`);
    assert.equal(gz.headers["content-encoding"], "gzip", "the browser gets the response as the app sent it");
    const missing = await viaProxy(rec.ports[B]!, `${base}/nope`);
    assert.equal(missing.status, 404);
    const posted = await viaProxy(rec.ports[B]!, `${base}/echo`, "POST", "hello");
    assert.equal(posted.body.toString(), "hello");

    const hits = await rec.stop();
    assert.deepEqual(hits.get(A), [
      { method: "GET", url: `${base}/app.js`, status: 200, blob: blobOf(Buffer.from("console.log(1)\n")) },
      { method: "GET", url: `${base}/gz`, status: 200, blob: blobOf(Buffer.from("zipped\n")) }
    ]);
    assert.deepEqual(hits.get(B), [
      { method: "GET", url: `${base}/nope`, status: 404, blob: blobOf(Buffer.from("not found")) },
      { method: "POST", url: `${base}/echo`, status: 201, blob: blobOf(Buffer.from("hello")) }
    ]);
  } finally {
    await rec.stop();
    await target.close();
  }
});

test("tunnels and upgrades pass through and are recorded without a body", async () => {
  const target = await app();
  const rec = await startRecorder([A]);
  try {
    const port = rec.ports[A]!;
    /** Sends `head`, then `send` once the proxy has answered, and collects until `until` matches. */
    const exchange = (head: string, send: string, until: RegExp) => new Promise<string>((resolve, reject) => {
      const s = connect(port, "127.0.0.1", () => s.write(head));
      let got = "";
      let sent = false;
      s.on("data", (d) => {
        got += d.toString();
        if (!sent && got.includes("\r\n\r\n")) { sent = true; s.write(send); }
        if (until.test(got)) { s.destroy(); resolve(got); }
      });
      s.on("error", reject);
      setTimeout(() => { s.destroy(); reject(new Error(`no ${until} in: ${got}`)); }, 5000).unref();
    });
    const tunnel = await exchange(`CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`,
      `GET /app.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`, /console\.log\(1\)/);
    assert.match(tunnel, /^HTTP\/1\.1 200 Connection Established/);
    const ws = await exchange(`GET http://localhost:${target.port}/live HTTP/1.1\r\nHost: localhost:${target.port}\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n`, "ping", /ping$/);
    assert.match(ws, /101 Switching Protocols[\s\S]*ping$/);

    const hits = await rec.stop();
    assert.deepEqual(hits.get(A), [
      { method: "CONNECT", url: `127.0.0.1:${target.port}`, status: 0, blob: null },
      { method: "GET", url: `http://localhost:${target.port}/live`, status: 101, blob: null }
    ]);
  } finally {
    await rec.stop();
    await target.close();
  }
});

test("a request the proxy can't deliver fails for the browser and is still recorded", async () => {
  const rec = await startRecorder([A]);
  const dead = `http://localhost:1/x`;
  const res = await viaProxy(rec.ports[A]!, dead);
  assert.equal(res.status, 502);
  const hits = await rec.stop();
  assert.deepEqual(hits.get(A), [{ method: "GET", url: dead, status: 502, blob: null }]);
});
