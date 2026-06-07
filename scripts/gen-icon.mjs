// Generates a 1024x1024 source PNG for `tauri icon` to fan out from.
// Pure Node (zlib) — no image deps. A simple indigo field with a lighter
// rounded square and a "W" notch; good enough as a placeholder identity.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 1024;
const bg = [27, 27, 27]; // ink
const fg = [59, 91, 219]; // accent indigo
const fg2 = [122, 146, 240];

function px(x, y) {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  // rounded square panel
  const half = SIZE * 0.34;
  const r = SIZE * 0.08;
  const dx = Math.abs(x - cx) - (half - r);
  const dy = Math.abs(y - cy) - (half - r);
  const inside =
    (dx <= 0 || dy <= 0) && Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) <= r;
  if (!inside) return bg;
  // a simple "W" drawn as two V strokes
  const nx = (x - cx) / half; // -1..1
  const ny = (y - cy) / half;
  const stroke = 0.16;
  const v1 = Math.abs(ny - (2 * Math.abs(nx + 0.45) - 0.6)) < stroke && nx < 0.05;
  const v2 = Math.abs(ny - (2 * Math.abs(nx - 0.45) - 0.6)) < stroke && nx > -0.05;
  return v1 || v2 ? fg2 : fg;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b] = px(x, y);
    raw[o++] = r;
    raw[o++] = g;
    raw[o++] = b;
    raw[o++] = 255;
  }
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = process.argv[2] ?? 'icon-src.png';
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
