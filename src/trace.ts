import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/**
 * Every file in a zip, by name. Just enough of the format for Playwright's
 * trace.zip (stored or deflated, no zip64), because thisisfine has no
 * dependencies. Sizes come from the central directory: the local headers
 * may defer them to a data descriptor.
 */
export function zipEntries(path: string): Map<string, Buffer> {
  const zip = readFileSync(path);
  const entries = new Map<string, Buffer>();
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error(`${path} is not a zip`);
  let p = zip.readUInt32LE(end + 16);
  for (let n = zip.readUInt16LE(end + 10); n > 0; n--) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error(`${path}: broken central directory`);
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLength);
    const local = zip.readUInt32LE(p + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    if (method === 0) entries.set(name, raw);
    else if (method === 8) entries.set(name, inflateRawSync(raw));
    p += 46 + nameLength + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return entries;
}

interface PageErrorEvent {
  method?: string;
  params?: {
    error?: { error?: { name?: string; message?: string }; value?: unknown };
    location?: { url?: string; line?: number; column?: number };
  };
}

/**
 * What the page threw while one check ran, from that check's own trace, in
 * the probe's format: "TypeError: … (/app.js:3:60)". The trace keeps a
 * location for errors thrown at run time (a click handler) but, like
 * "pageerror", not for a SyntaxError; the load-time probe covers those.
 * Best effort, never throws.
 */
export function traceErrors(zipPath: string): string[] {
  let entries: Map<string, Buffer>;
  try {
    entries = zipEntries(zipPath);
  } catch {
    return [];
  }
  const errors: string[] = [];
  for (const [name, content] of entries) {
    if (!/^\d+-trace\.trace$/.test(name)) continue;
    for (const line of content.toString("utf8").split("\n")) {
      if (!line.includes('"pageError"')) continue;
      let event: PageErrorEvent;
      try { event = JSON.parse(line) as PageErrorEvent; } catch { continue; }
      if (event.method !== "pageError") continue;
      const e = event.params?.error;
      const what = (e?.error ? [e.error.name, e.error.message].filter(Boolean).join(": ") : String(e?.value ?? "error")).split("\n")[0];
      const at = event.params?.location;
      const where = at?.url ? ` (${at.url.replace(/^[a-z]+:\/\/[^/]+/i, "")}:${(at.line ?? 0) + 1}:${(at.column ?? 0) + 1})` : "";
      errors.push(what + where);
    }
  }
  return [...new Set(errors)];
}
