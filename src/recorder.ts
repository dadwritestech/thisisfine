import { createServer, request } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { blobOf } from "./git.ts";
import type { Hit } from "./select.ts";

/** Bodies bigger than this aren't hashed; their hit counts as unexplained. */
const MAX_BODY = 32 * 1024 * 1024;

export interface Recorder {
  /** One proxy port per check: the port a request arrives on says whose it is. */
  ports: Record<string, number>;
  /** Closes every proxy (idempotent) and returns what each check's browser asked for. */
  stop(): Promise<Map<string, Hit[]>>;
}

function decoded(body: Buffer, encoding: string | undefined): Buffer | null {
  try {
    switch ((encoding ?? "identity").trim().toLowerCase()) {
      case "identity": case "": return body;
      case "gzip": case "x-gzip": return gunzipSync(body);
      case "deflate": return inflateSync(body);
      case "br": return brotliDecompressSync(body);
      default: return null;
    }
  } catch {
    return null;
  }
}

function forwardHeaders(req: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined && k !== "proxy-connection" && k !== "proxy-authorization") headers[k] = v;
  }
  return headers;
}

function proxyFor(hits: Hit[], sockets: Set<Socket>): Server {
  const server = createServer((req, res) => {
    const hit: Hit = { method: req.method ?? "GET", url: req.url ?? "", status: 0, blob: null };
    hits.push(hit);
    let url: URL;
    try {
      url = new URL(req.url ?? "");
      if (url.protocol !== "http:") throw new Error("not http");
    } catch {
      hit.status = 400;
      res.writeHead(400).end("thisisfine's recording proxy only forwards absolute http:// requests");
      return;
    }
    const upstream = request(url, { method: req.method, headers: forwardHeaders(req) }, (up) => {
      hit.status = up.statusCode ?? 0;
      res.writeHead(up.statusCode ?? 502, up.rawHeaders);
      const chunks: Buffer[] = [];
      let size = 0;
      up.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c);
        res.write(c);
      });
      up.on("end", () => {
        const body = size <= MAX_BODY ? decoded(Buffer.concat(chunks), up.headers["content-encoding"]) : null;
        hit.blob = body ? blobOf(body) : null;
        res.end();
      });
      up.on("error", () => res.destroy());
    });
    upstream.on("error", () => {
      hit.status = 502;
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.pipe(upstream);
  });

  // HTTPS and other tunnels: forwarded blind, recorded by host only.
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    hits.push({ method: "CONNECT", url: req.url ?? "", status: 0, blob: null });
    const [host, port] = splitHostPort(req.url ?? "");
    const up = connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    track(sockets, up);
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });

  // Websockets (dev-server live reload, app sockets): replay the request, then splice.
  server.on("upgrade", (req: IncomingMessage, client: Socket, head: Buffer) => {
    const hit: Hit = { method: req.method ?? "GET", url: req.url ?? "", status: 0, blob: null };
    hits.push(hit);
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      client.destroy();
      return;
    }
    const up = connect(Number(url.port || 80), url.hostname.replace(/^\[|\]$/g, ""), () => {
      const lines = [`${req.method} ${url.pathname}${url.search} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (!/^proxy-/i.test(req.rawHeaders[i]!)) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) up.write(head);
      up.once("data", (d: Buffer) => {
        hit.status = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(d.toString("latin1"))?.[1] ?? 0);
      });
      up.pipe(client);
      client.pipe(up);
    });
    track(sockets, up);
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });

  server.on("connection", (s: Socket) => track(sockets, s));
  return server;
}

function splitHostPort(target: string): [string, number] {
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target);
  return m ? [m[1]!, Number(m[2])] : [target, 443];
}

function track(sockets: Set<Socket>, s: Socket): void {
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
}

/**
 * Starts one forward proxy per check on 127.0.0.1. Playwright is told to
 * send each check's browser through its own proxy (and already forces
 * Chromium to proxy loopback too), so every request the page makes, to
 * any port, is seen and attributed without touching a single header.
 */
export async function startRecorder(checks: string[]): Promise<Recorder> {
  const hits = new Map<string, Hit[]>();
  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  const ports: Record<string, number> = {};
  for (const check of checks) {
    const list: Hit[] = [];
    hits.set(check, list);
    const server = proxyFor(list, sockets);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    servers.push(server);
    ports[check] = (server.address() as AddressInfo).port;
  }
  let stopped: Promise<Map<string, Hit[]>> | null = null;
  return {
    ports,
    stop() {
      stopped ??= (async () => {
        for (const s of sockets) s.destroy();
        await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
        return hits;
      })();
      return stopped;
    }
  };
}
