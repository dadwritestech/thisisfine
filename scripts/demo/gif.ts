/**
 * A small animated GIF encoder with no dependencies.
 *
 * - One global 255-colour palette (median cut over every frame), index 255 is transparent.
 * - Each frame stores only the rectangle that changed since the previous one, and
 *   unchanged pixels inside it are transparent, so typing frames cost almost nothing.
 * - Frames are fetched twice (palette pass, then encode pass) so the caller can keep
 *   them compressed instead of holding every RGBA buffer in memory.
 */

export interface Frame { rgba: Uint8Array; delayMs: number }

const TRANSPARENT = 255;
const key15 = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/**
 * Median cut over a 15-bit histogram. `sums` holds the true R, G, B totals of each bucket,
 * so a flat colour comes back exact instead of snapped to its bucket's centre.
 * Returns up to `max` RGB colours.
 */
export function buildPalette(histogram: Float64Array, sums: Float64Array, max = 255): number[][] {
  interface Box { keys: number[]; count: number; range: number; axis: number }
  const channel = (k: number, axis: number) => (k >> (10 - axis * 5)) & 31;
  const makeBox = (keys: number[]): Box => {
    let count = 0, range = -1, axis = 0;
    for (let a = 0; a < 3; a++) {
      let lo = 31, hi = 0;
      for (const k of keys) { const c = channel(k, a); if (c < lo) lo = c; if (c > hi) hi = c; }
      if (hi - lo > range) { range = hi - lo; axis = a; }
    }
    for (const k of keys) count += histogram[k]!;
    return { keys, count, range, axis };
  };
  const used: number[] = [];
  for (let k = 0; k < histogram.length; k++) if (histogram[k]! > 0) used.push(k);
  const boxes = [makeBox(used)];
  while (boxes.length < max) {
    // Split where it helps most: wide boxes, weighted (gently) by how many pixels they hold,
    // so rare but important colours (a red flame, a green tick) still get their own entry.
    let best = -1, score = 0;
    boxes.forEach((b, i) => { const s = b.range * Math.sqrt(b.count); if (b.keys.length > 1 && s > score) { score = s; best = i; } });
    if (best < 0) break;
    const box = boxes[best]!;
    box.keys.sort((x, y) => channel(x, box.axis) - channel(y, box.axis));
    let acc = 0, cut = 1;
    for (let i = 0; i < box.keys.length - 1; i++) {
      acc += histogram[box.keys[i]!]!;
      if (acc >= box.count / 2) { cut = i + 1; break; }
      cut = i + 1;
    }
    boxes.splice(best, 1, makeBox(box.keys.slice(0, cut)), makeBox(box.keys.slice(cut)));
  }
  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0, n = 0;
    for (const k of b.keys) { r += sums[k * 3]!; g += sums[k * 3 + 1]!; bl += sums[k * 3 + 2]!; n += histogram[k]!; }
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  });
}

/** LZW-compress indexed pixels (min code size 8) into GIF sub-blocks. */
export function lzw(indices: Uint8Array): Uint8Array {
  const out: number[] = [];
  let bitBuf = 0, bitLen = 0;
  const block: number[] = [];
  const emitByte = (b: number) => { block.push(b); if (block.length === 255) { out.push(255, ...block); block.length = 0; } };
  const CLEAR = 256, EOI = 257;
  let codeSize = 9, next = 258;
  const table = new Int32Array(4096 * 256).fill(-1);
  const write = (code: number) => {
    bitBuf |= code << bitLen; bitLen += codeSize;
    while (bitLen >= 8) { emitByte(bitBuf & 255); bitBuf >>>= 8; bitLen -= 8; }
  };
  write(CLEAR);
  if (indices.length) {
    let prefix = indices[0]!;
    for (let i = 1; i < indices.length; i++) {
      const c = indices[i]!;
      const found = table[(prefix << 8) | c]!;
      if (found >= 0) { prefix = found; continue; }
      write(prefix);
      if (next < 4096) {
        table[(prefix << 8) | c] = next++;
        if (next > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        write(CLEAR);
        table.fill(-1); codeSize = 9; next = 258;
      }
      prefix = c;
    }
    write(prefix);
  }
  write(EOI);
  if (bitLen > 0) emitByte(bitBuf & 255);
  if (block.length) out.push(block.length, ...block);
  out.push(0);
  return Uint8Array.from(out);
}

export function encodeGif(width: number, height: number, count: number, frame: (i: number) => Frame): Uint8Array {
  const histogram = new Float64Array(32768), sums = new Float64Array(32768 * 3);
  for (let i = 0; i < count; i++) {
    const { rgba } = frame(i);
    for (let p = 0; p < rgba.length; p += 4) {
      const k = key15(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!);
      histogram[k]++; sums[k * 3] += rgba[p]!; sums[k * 3 + 1] += rgba[p + 1]!; sums[k * 3 + 2] += rgba[p + 2]!;
    }
  }
  const palette = buildPalette(histogram, sums, 255);
  const lut = new Int16Array(32768).fill(-1);
  const nearest = (k: number) => {
    const n = histogram[k]!, r = sums[k * 3]! / n, g = sums[k * 3 + 1]! / n, b = sums[k * 3 + 2]! / n;
    let best = 0, bestD = Infinity;
    palette.forEach(([pr, pg, pb], i) => { const d = (r - pr!) ** 2 * 2 + (g - pg!) ** 2 * 4 + (b - pb!) ** 2 * 3; if (d < bestD) { bestD = d; best = i; } });
    return (lut[k] = best);
  };

  const bytes: number[] = [];
  const u16 = (v: number) => bytes.push(v & 255, v >> 8);
  bytes.push(...Buffer.from("GIF89a")); u16(width); u16(height);
  bytes.push(0xf7, 0, 0); // global colour table, 8 bits, 256 entries
  for (let i = 0; i < 256; i++) bytes.push(...(palette[i] ?? [0, 0, 0]));
  bytes.push(0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0); // loop forever

  let prev: Uint8Array | null = null;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const { rgba, delayMs } = frame(i);
    const idx = new Uint8Array(width * height);
    for (let p = 0, q = 0; q < idx.length; p += 4, q++) {
      const k = key15(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!);
      idx[q] = lut[k]! >= 0 ? lut[k]! : nearest(k);
    }
    let x0 = 0, y0 = 0, x1 = width - 1, y1 = height - 1;
    if (prev) {
      x0 = width; y0 = height; x1 = -1; y1 = -1;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const q = y * width + x;
        if (idx[q] !== prev[q]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) { x0 = y0 = x1 = y1 = 0; } // nothing changed: a 1px no-op frame carries the delay
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const sub = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const q = (y + y0) * width + x + x0;
      sub[y * w + x] = prev && idx[q] === prev[q] ? TRANSPARENT : idx[q]!;
    }
    const cs = Math.max(2, Math.round(delayMs / 10));
    const head: number[] = [0x21, 0xf9, 4, (1 << 2) | 1, cs & 255, cs >> 8, TRANSPARENT, 0];
    head.push(0x2c, x0 & 255, x0 >> 8, y0 & 255, y0 >> 8, w & 255, w >> 8, h & 255, h >> 8, 0, 8);
    chunks.push(Uint8Array.from(head), lzw(sub));
    prev = idx;
  }
  const tail = Uint8Array.of(0x3b);
  const total = bytes.length + chunks.reduce((n, c) => n + c.length, 0) + 1;
  const outBuf = new Uint8Array(total);
  outBuf.set(bytes, 0);
  let off = bytes.length;
  for (const c of chunks) { outBuf.set(c, off); off += c.length; }
  outBuf.set(tail, off);
  return outBuf;
}
