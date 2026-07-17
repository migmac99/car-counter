#!/usr/bin/env node
/**
 * Generates the PWA icon set as PNGs with no dependencies (hand-rolled PNG
 * encoder over node:zlib). Icons are committed; re-run only to change the art.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'public', 'icons');

// --- Minimal PNG encoder (RGBA, 8-bit) ---
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Icon art: car silhouette crossing a dashed counting line ---
const BG = [0x0f, 0x17, 0x2a]; // deep navy
const CAR = [0xf8, 0xfa, 0xfc];
const LINE = [0x38, 0xbd, 0xf8]; // sky blue

function renderIcon(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const s = (v) => v * size; // normalized -> pixel
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };
  const fill = (test, color) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) if (test((x + 0.5) / size, (y + 0.5) / size)) set(x, y, color);
  };
  const inRoundRect = (u, v, x0, y0, x1, y1, r) => {
    if (u < x0 || u > x1 || v < y0 || v > y1) return false;
    const cx = Math.max(x0 + r, Math.min(u, x1 - r));
    const cy = Math.max(y0 + r, Math.min(v, y1 - r));
    return (u - cx) ** 2 + (v - cy) ** 2 <= r * r || (u >= x0 + r && u <= x1 - r) || (v >= y0 + r && v <= y1 - r);
  };
  const inCircle = (u, v, cx, cy, r) => (u - cx) ** 2 + (v - cy) ** 2 <= r * r;

  // Background: full-bleed for maskable, rounded tile otherwise
  const bgRadius = maskable ? 0.5 : 0.18;
  fill((u, v) => (maskable ? true : inRoundRect(u, v, 0.02, 0.02, 0.98, 0.98, bgRadius)), BG);

  // Vertical dashed counting line behind the car
  fill((u, v) => Math.abs(u - 0.5) < 0.025 && Math.floor(v * 9) % 2 === 0, LINE);

  // Car: cabin + body + wheels, centered, pointing right
  fill((u, v) => inRoundRect(u, v, 0.34, 0.38, 0.72, 0.55, 0.06), CAR); // cabin
  fill((u, v) => inRoundRect(u, v, 0.2, 0.5, 0.84, 0.68, 0.07), CAR); // body
  fill((u, v) => inCircle(u, v, 0.34, 0.7, 0.075), CAR); // rear wheel
  fill((u, v) => inCircle(u, v, 0.68, 0.7, 0.075), CAR); // front wheel
  fill((u, v) => inCircle(u, v, 0.34, 0.7, 0.035), BG); // rear hub
  fill((u, v) => inCircle(u, v, 0.68, 0.7, 0.035), BG); // front hub

  return encodePng(size, size, px);
}

await mkdir(OUT, { recursive: true });
const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
];
for (const [name, size, opts] of targets) {
  await writeFile(join(OUT, name), renderIcon(size, opts));
  console.log(`wrote icons/${name}`);
}
