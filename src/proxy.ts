import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { dirname } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

/** Per body, in the evidence. The check itself always gets every byte. */
const SHOWN = 2000;
/** Compressed bodies are only decoded for the evidence if they're this small. */
const DECODE_MAX = 1024 * 1024;

export interface EvidenceProxy {
  url: string;
  stop(): Promise<void>;
}

class Sample {
  private chunks: Buffer[] = [];
  private kept = 0;
  total = 0;
  add(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.kept < DECODE_MAX) {
      this.chunks.push(chunk);
      this.kept += chunk.length;
    }
  }
  /** Human-readable, decoded, pretty if JSON, cut at SHOWN. */
  text(headers: IncomingHttpHeaders): string {
    if (this.total === 0) return "";
    let body = Buffer.concat(this.chunks);
    const encoding = String(headers["content-encoding"] ?? "").trim().toLowerCase();
    if (encoding && encoding !== "identity") {
      if (this.total > this.kept) return `(${this.total} bytes, ${encoding})`;
      try {
        body = encoding === "br" ? brotliDecompressSync(body) : encoding === "deflate" ? inflateSync(body) : gunzipSync(body);
      } catch {
        return `(${this.total} bytes, ${encoding})`;
      }
    }
    const type = String(headers["content-type"] ?? "");
    if (/image\/|audio\/|video\/|octet-stream|font\//.test(type)) return `(${this.total} bytes, ${type})`;
    let text = body.toString("utf8");
    if (/json/.test(type) || /^\s*[{[]/.test(text)) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // not JSON after all
      }
    }
    const more = text.length > SHOWN || this.total > this.kept ? `\n… (${Math.max(0, Buffer.byteLength(text) - SHOWN) + (this.total - this.kept)} more bytes)` : "";
    return text.slice(0, SHOWN) + more;
  }
}

const prefixed = (mark: string, text: string) => (text ? text.split("\n").map((l) => `${mark} ${l}`).join("\n") + "\n" : "");

/**
 * A reverse proxy in front of the app, used during proofs so the human sees
 * what an API check actually did: method, path, status, and both bodies.
 * It's a reverse proxy (THISISFINE_BASE_URL points at it) rather than an
 * HTTP_PROXY, because many clients (Go's net/http among them) never send
 * localhost traffic through a proxy. Requests and responses stream; only
 * the copy kept for the evidence is sampled.
 */
export async function startEvidenceProxy(target: string, evidenceFile: string): Promise<EvidenceProxy> {
  const t = new URL(target);
  mkdirSync(dirname(evidenceFile), { recursive: true });
  const write = (entry: string) => {
    try {
      appendFileSync(evidenceFile, entry + "\n");
    } catch {
      // evidence is a courtesy
    }
  };
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    const path = req.url ?? "/";
    const sent = new Sample();
    req.on("data", (c: Buffer) => sent.add(c));
    const upstream = request({
      host: t.hostname, port: t.port, method: req.method, path, headers: req.headers
    }, (up) => {
      const got = new Sample();
      up.on("data", (c: Buffer) => got.add(c));
      up.on("end", () => {
        write(`${req.method} ${path} → ${up.statusCode}\n${prefixed(">", sent.text(req.headers))}${prefixed("<", got.text(up.headers))}`);
      });
      res.writeHead(up.statusCode ?? 502, up.statusMessage, up.headers);
      up.pipe(res);
    });
    upstream.on("error", (err) => {
      write(`${req.method} ${path} → 502 (the app didn't answer: ${err.message})\n`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`thisisfine: the app didn't answer (${err.message})`);
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket: Socket, head: Buffer) => {
    const path = req.url ?? "/";
    const up = connect(Number(t.port), t.hostname, () => {
      const lines = [`${req.method} ${path} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) up.write(head);
      write(`${req.method} ${path} → upgraded\n`);
      up.pipe(socket);
      socket.pipe(up);
    });
    sockets.add(up);
    up.on("close", () => sockets.delete(up));
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  let stopped: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${port}`,
    stop() {
      stopped ??= new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
      return stopped;
    }
  };
}
