/** The demo GIF encoder (scripts/demo/gif.ts), checked by decoding what it writes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { encodeGif, lzw } from "../scripts/demo/gif.ts";
import { decodePng } from "../scripts/demo/png.ts";

/** A plain GIF LZW decoder over concatenated sub-blocks (min code size 8). */
function unlzw(blocks: Uint8Array): number[] {
  const data: number[] = [];
  for (let p = 0; blocks[p] !== 0; p += blocks[p]! + 1) data.push(...blocks.subarray(p + 1, p + 1 + blocks[p]!));
  const out: number[] = [];
  let dict: number[][] = [], size = 9, bit = 0, prev: number[] | null = null;
  const reset = () => { dict = Array.from({ length: 258 }, (_, i) => [i]); size = 9; prev = null; };
  reset();
  for (;;) {
    let code = 0;
    for (let i = 0; i < size; i++, bit++) code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << i;
    if (code === 256) { reset(); continue; }
    if (code === 257) return out;
    const entry: number[] = code < dict.length ? dict[code]! : [...prev!, prev![0]!];
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]!]);
    prev = entry;
    if (dict.length === 1 << size && size < 12) size++;
  }
}

test("lzw round-trips short, repetitive, and table-overflowing input", () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
  for (const input of [[], [5], Array(10_000).fill(9), Array.from({ length: 50_000 }, rand), Array.from({ length: 30_000 }, (_, i) => (i * 7) % 13)]) {
    assert.deepEqual(unlzw(lzw(Uint8Array.from(input))), input);
  }
});

test("frames after the first only store the changed rectangle, with the rest transparent", () => {
  const w = 4, h = 3;
  const solid = (r: number, g: number, b: number) => Uint8Array.from({ length: w * h * 4 }, (_, i) => [r, g, b, 255][i % 4]!);
  const second = solid(0, 0, 0);
  second.set([255, 0, 0, 255], (1 * w + 2) * 4); // one red pixel at (2,1)
  const frames = [{ rgba: solid(0, 0, 0), delayMs: 500 }, { rgba: second, delayMs: 1000 }];
  const gif = encodeGif(w, h, 2, (i) => frames[i]!);

  assert.equal(Buffer.from(gif.subarray(0, 6)).toString(), "GIF89a");
  assert.equal(gif.at(-1), 0x3b);
  const palette = gif.subarray(13, 13 + 768);
  const descriptors = [...gif.keys()].filter((i) => gif[i] === 0x2c && gif[i - 8] === 0x21 && gif[i - 7] === 0xf9);
  assert.equal(descriptors.length, 2);
  const at = descriptors[1]!;
  const rect = [gif[at + 1]!, gif[at + 3]!, gif[at + 5]!, gif[at + 7]!];
  assert.deepEqual(rect, [2, 1, 1, 1], "second frame is just the red pixel");
  assert.equal(gif[at - 4]! | (gif[at - 3]! << 8), 100, "delay in centiseconds");
  const [index] = unlzw(gif.subarray(at + 11));
  assert.deepEqual([...palette.subarray(index! * 3, index! * 3 + 3)], [255, 0, 0], "the exact colour, not its bucket's centre");
});

test("decodePng reads 8-bit RGB with every filter type", () => {
  const w = 3, h = 5, bpp = 3;
  const px = Uint8Array.from({ length: w * h * bpp }, (_, i) => (i * 37) % 256);
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    const filter = y; // 0 none, 1 sub, 2 up, 3 average, 4 paeth
    rows.push(filter);
    for (let x = 0; x < w * bpp; x++) {
      const v = px[y * w * bpp + x]!;
      const a = x >= bpp ? px[y * w * bpp + x - bpp]! : 0;
      const b = y ? px[(y - 1) * w * bpp + x]! : 0;
      const c = x >= bpp && y ? px[(y - 1) * w * bpp + x - bpp]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]!;
      rows.push((v - pred) & 255);
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4);
    return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC is not checked
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Uint8Array.from(rows))), chunk("IEND", new Uint8Array())]);
  const img = decodePng(png);
  assert.equal(img.width, w);
  for (let i = 0; i < w * h; i++) assert.deepEqual([...img.rgba.subarray(i * 4, i * 4 + 4)], [...px.subarray(i * 3, i * 3 + 3), 255]);
});
