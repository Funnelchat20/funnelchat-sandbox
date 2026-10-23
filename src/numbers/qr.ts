/**
 * A fake QR code: a real PNG that looks like one (three finder squares and modules derived from a seed), so a UI can
 * show it, but nothing can scan it. In the sandbox a number connects with `POST /_sandbox/devices/{id}/connect`.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const MODULES = 25;
const SCALE = 6;
const QUIET = 4;

let crcTable: Int32Array | null = null;

function crc32(bytes: Buffer): number {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Dark modules of a 25×25 grid: the three finder squares, the timing lines, and the rest from the seed. */
function modules(seed: string): boolean[][] {
  const bits = createHash('sha512').update(seed).digest();
  const grid = Array.from({ length: MODULES }, (_, y) =>
    Array.from({ length: MODULES }, (_, x) => {
      const i = y * MODULES + x;
      return (((bits[i % bits.length] as number) >> (i % 8)) & 1) === 1;
    }),
  );
  const finder = (ox: number, oy: number) => {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const gx = ox + x;
        const gy = oy + y;
        if (gx < 0 || gy < 0 || gx >= MODULES || gy >= MODULES) continue;
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        (grid[gy] as boolean[])[gx] = ring !== 2 && ring <= 3;
      }
    }
  };
  finder(0, 0);
  finder(MODULES - 7, 0);
  finder(0, MODULES - 7);
  for (let i = 8; i < MODULES - 8; i++) {
    (grid[6] as boolean[])[i] = i % 2 === 0;
    (grid[i] as boolean[])[6] = i % 2 === 0;
  }
  return grid;
}

/** The PNG, as a `data:image/png;base64,…` URI. The same seed gives the same image. */
export function fakeQrDataUri(seed: string): string {
  const grid = modules(seed);
  const size = (MODULES + QUIET * 2) * SCALE;
  // One filter byte (0) per row, then one grey byte per pixel.
  const raw = Buffer.alloc((size + 1) * size, 0xff);
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0;
    const my = Math.floor(y / SCALE) - QUIET;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / SCALE) - QUIET;
      const dark = my >= 0 && mx >= 0 && my < MODULES && mx < MODULES && (grid[my] as boolean[])[mx];
      if (dark) raw[y * (size + 1) + 1 + x] = 0x00;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
