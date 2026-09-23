/**
 * A terminal capture as an SVG, for the README: text with its ANSI colours (16, 256 and
 * 24-bit, foreground and background, bold, dim), in a window frame. Sharp at any size,
 * light, its text selectable — and nothing to install.
 *
 *   tmux capture-pane -e -p -t <pane> | npx tsx docs/tools/term-svg.ts > docs/terminal.svg
 *
 * Before drawing, what is private is replaced — a home path, a conversation id, a pairing
 * code, an operator key — and the capture is refused if one is still there.
 */
import { readFileSync } from 'node:fs';

/** What must never be published, and what it becomes. */
const SCRUB: [RegExp, string][] = [
  [/\/home\/[^/\s]+/g, '~'],
  [/\/Users\/[^/\s]+/g, '~'],
  [/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g, 'XXXX-XXXX-XXXX'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '0000-…'],
  [/\b(gemini\.google\.com\/app\/)[0-9a-f]{8,}/g, '$1…'],
];
/** Still there after scrubbing: refuse. */
const FORBIDDEN = [/\/home\//, /[A-Za-z0-9+/]{32,}={0,2}/, /\bgho_|\bghp_|\bsk-/];

export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUB) out = out.replace(pattern, replacement);
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  for (const pattern of FORBIDDEN) {
    const found = pattern.exec(plain);
    if (found) throw new Error(`private data left in the capture: "${found[0].slice(0, 20)}…" — not drawn`);
  }
  return out;
}

const BASE = ['#1e1e2e', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de'];
const BRIGHT = ['#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'];
const FG = '#cdd6f4';
const BG = '#1e1e2e';

function xterm256(n: number): string {
  if (n < 8) return BASE[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const c = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return rgb(level(Math.floor(c / 36)), level(Math.floor(c / 6) % 6), level(c % 6));
  }
  const g = 8 + (n - 232) * 10;
  return rgb(g, g, g);
}
const rgb = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

interface Cell {
  ch: string;
  fg: string;
  bg: string | null;
  bold: boolean;
  dim: boolean;
}

/** The capture as rows of cells, each with its colours. */
export function parse(text: string): Cell[][] {
  let fg = FG;
  let bg: string | null = null;
  let bold = false;
  let dim = false;
  const rows: Cell[][] = [];
  for (const line of text.replace(/\n+$/, '').split('\n')) {
    const row: Cell[] = [];
    const parts = line.split(/(\x1b\[[0-9;]*m)/);
    for (const part of parts) {
      const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (!sgr) {
        for (const ch of part) row.push({ ch, fg, bg, bold, dim });
        continue;
      }
      const codes = sgr[1] === '' ? [0] : sgr[1].split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) [fg, bg, bold, dim] = [FG, null, false, false];
        else if (c === 1) bold = true;
        else if (c === 2) dim = true;
        else if (c === 22) [bold, dim] = [false, false];
        else if (c >= 30 && c <= 37) fg = BASE[c - 30];
        else if (c >= 90 && c <= 97) fg = BRIGHT[c - 90];
        else if (c === 39) fg = FG;
        else if (c >= 40 && c <= 47) bg = BASE[c - 40];
        else if (c >= 100 && c <= 107) bg = BRIGHT[c - 100];
        else if (c === 49) bg = null;
        else if (c === 38 || c === 48) {
          let colour: string | undefined;
          if (codes[i + 1] === 5) {
            colour = xterm256(codes[i + 2]);
            i += 2;
          } else if (codes[i + 1] === 2) {
            colour = rgb(codes[i + 2], codes[i + 3], codes[i + 4]);
            i += 4;
          }
          if (colour) {
            if (c === 38) fg = colour;
            else bg = colour;
          }
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The cells drawn: backgrounds as rectangles, text in runs of one style, in a window frame. */
export function render(rows: Cell[][], title = 'bushwhack'): string {
  const size = 14;
  const cw = size * 0.6;
  const lh = size * 1.3;
  const pad = 16;
  const bar = 30;
  const cols = Math.max(...rows.map((r) => r.length), 40);
  const width = Math.ceil(cols * cw + pad * 2);
  const height = Math.ceil(rows.length * lh + pad * 2 + bar);
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace" font-size="${size}">`);
  out.push(`<rect width="${width}" height="${height}" rx="10" fill="${BG}"/>`);
  out.push(`<circle cx="18" cy="15" r="6" fill="#f38ba8"/><circle cx="38" cy="15" r="6" fill="#f9e2af"/><circle cx="58" cy="15" r="6" fill="#a6e3a1"/>`);
  out.push(`<text x="${width / 2}" y="20" fill="#6c7086" text-anchor="middle" font-size="12">${esc(title)}</text>`);
  rows.forEach((row, y) => {
    const top = bar + pad + y * lh;
    // Backgrounds: runs of one colour.
    for (let x = 0; x < row.length; ) {
      const bg = row[x].bg;
      let end = x;
      while (end < row.length && row[end].bg === bg) end++;
      if (bg) out.push(`<rect x="${(pad + x * cw).toFixed(1)}" y="${(top - 1).toFixed(1)}" width="${((end - x) * cw + 0.5).toFixed(1)}" height="${(lh + 0.5).toFixed(1)}" fill="${bg}"/>`);
      x = end;
    }
    // Block glyphs (the mascot, two pixels a character) as rectangles: a font's ▀ does not
    // always fill its cell, and the picture would come out striped.
    row.forEach((cell, x) => {
      const left = (pad + x * cw).toFixed(1);
      const w = (cw + 0.5).toFixed(1);
      const half = lh / 2;
      if (cell.ch === '▀') out.push(`<rect x="${left}" y="${(top - 1).toFixed(1)}" width="${w}" height="${(half + 0.5).toFixed(1)}" fill="${cell.fg}"/>`);
      else if (cell.ch === '▄') out.push(`<rect x="${left}" y="${(top - 1 + half).toFixed(1)}" width="${w}" height="${(half + 0.5).toFixed(1)}" fill="${cell.fg}"/>`);
      else if (cell.ch === '█') out.push(`<rect x="${left}" y="${(top - 1).toFixed(1)}" width="${w}" height="${(lh + 0.5).toFixed(1)}" fill="${cell.fg}"/>`);
    });
    // Text: runs of one style, each placed at its column so a wide glyph never shifts the rest.
    const spans: string[] = [];
    for (let x = 0; x < row.length; ) {
      const { fg, bold, dim } = row[x];
      let end = x;
      while (end < row.length && row[end].fg === fg && row[end].bold === bold && row[end].dim === dim) end++;
      const text = row
        .slice(x, end)
        .map((c) => ('▀▄█'.includes(c.ch) ? ' ' : c.ch))
        .join('');
      if (text.trim() !== '') {
        spans.push(`<tspan x="${(pad + x * cw).toFixed(1)}" fill="${fg}"${bold ? ' font-weight="bold"' : ''}${dim ? ' opacity="0.6"' : ''}>${esc(text)}</tspan>`);
      }
      x = end;
    }
    if (spans.length) out.push(`<text y="${(top + size).toFixed(1)}" xml:space="preserve">${spans.join('')}</text>`);
  });
  out.push('</svg>');
  return out.join('\n') + '\n';
}

// Run as a script: stdin → stdout.
if (process.argv[1]?.split('\\').join('/').endsWith('docs/tools/term-svg.ts')) {
  const title = process.argv[2] ?? 'bushwhack';
  process.stdout.write(render(parse(scrub(readFileSync(0, 'utf8'))), title));
}
