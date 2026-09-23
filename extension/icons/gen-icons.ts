// The icons, from bushwhack's mascot (@bushwhack/protocol's SPRITE, which the CLI's banner
// draws too): the extension's PNGs, each size a whole multiple of the 16×16 grid so no pixel
// is blurred, the panel's SVG, and the Windows tray's .ico files — the mascot, and grey
// for a service that is not running. No dependency: PNGs are written with zlib.
//
//   npm run ext:icons
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { PALETTE, SPRITE } from '@bushwhack/protocol';

const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** A palette's colours as greys, of the same lightness: the mascot asleep. */
export function grey(palette: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(palette).map(([k, hex]) => {
      const [r, g, b] = rgb(hex);
      const l = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
      const v = l.toString(16).padStart(2, '0');
      return [k, `#${v}${v}${v}`];
    }),
  );
}

/** An .ico of PNG frames — 6 bytes of header, 16 per frame, then the PNGs. */
export function ico(pngs: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header[at] = size >= 256 ? 0 : size;
    header[at + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

/** A PNG of the sprite, each of its pixels `scale` pixels wide. */
export function png(scale: number, sprite: readonly string[] = SPRITE, palette: Readonly<Record<string, string>> = PALETTE): Buffer {
  const size = sprite.length * scale;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const c = sprite[Math.floor(y / scale)][Math.floor(x / scale)];
      if (c === '.') continue;
      const [r, g, b] = rgb(palette[c]);
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
  // The Windows tray: whole multiples only (16…256), Windows picks the frame for its size.
  const frames = (palette: Readonly<Record<string, string>>) => [1, 2, 3, 4, 16].map((scale) => ({ size: 16 * scale, data: png(scale, SPRITE, palette) }));
  writeFileSync(new URL('tray.ico', here), ico(frames(PALETTE)));
  writeFileSync(new URL('tray-down.ico', here), ico(frames(grey(PALETTE))));
  writeFileSync(new URL('preview.png', here), png(24));
  console.log('extension/icons: icon-16/32/48/128.png, icon.svg, tray.ico, tray-down.ico (and preview.png, not shipped)');
}
