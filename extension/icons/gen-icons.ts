// The extension's icons, from bushwhack's mascot (@bushwhack/protocol's SPRITE, which the
// CLI's banner draws too): the PNGs, each size a whole multiple of the 16×16 grid so no
// pixel is blurred, and the panel's SVG. No dependency: PNGs are written with zlib.
//
//   npm run ext:icons
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { PALETTE, SPRITE } from '@bushwhack/protocol';

const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** A PNG of the sprite, each of its pixels `scale` pixels wide. */
export function png(scale: number, sprite: readonly string[] = SPRITE): Buffer {
  const size = sprite.length * scale;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const c = sprite[Math.floor(y / scale)][Math.floor(x / scale)];
      if (c === '.') continue;
      const [r, g, b] = rgb(PALETTE[c]);
      row.set([r, g, b, 255], 1 + x * 4);
    }
    rows.push(row);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** The sprite as SVG rectangles: sharp at any size (shape-rendering crispEdges). */
export function svg(sprite: readonly string[] = SPRITE): string {
  const rects = sprite.flatMap((row, y) => [...row].map((c, x) => (c === '.' ? '' : `<rect x="${x}" y="${y}" width="1" height="1" fill="${PALETTE[c]}"/>`)).filter(Boolean));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sprite.length} ${sprite.length}" shape-rendering="crispEdges">${rects.join('')}</svg>\n`;
}

// Run as a script (not imported): write the files.
if (process.argv[1]?.split('\\').join('/').endsWith('extension/icons/gen-icons.ts')) {
  const here = new URL('.', import.meta.url);
  for (const size of [16, 32, 48, 128]) writeFileSync(new URL(`icon-${size}.png`, here), png(size / 16));
  writeFileSync(new URL('icon.svg', here), svg());
  writeFileSync(new URL('preview.png', here), png(24));
  console.log('extension/icons: icon-16/32/48/128.png, icon.svg (and preview.png, not shipped)');
}
