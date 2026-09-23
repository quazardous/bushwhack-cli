/**
 * The mascot at the top of `bushwhack`: the extension's icon, in the terminal. Two pixels a
 * character — `▀` in the upper pixel's colour on the lower one's — in 24-bit colour, which
 * Windows Terminal, and every usual terminal elsewhere, shows.
 */
import { PALETTE, SPRITE } from '@bushwhack/protocol';

const rgb = (letter: string): string => {
  const hex = PALETTE[letter];
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(';');
};

/** The sprite, half as many lines as it has rows. */
export function mascotLines(sprite: readonly string[] = SPRITE): string[] {
  const lines: string[] = [];
  for (let y = 0; y < sprite.length; y += 2) {
    let line = '';
    for (let x = 0; x < sprite[y].length; x++) {
      const top = sprite[y][x];
      const bottom = sprite[y + 1]?.[x] ?? '.';
      if (top === '.' && bottom === '.') line += '\x1b[0m ';
      else if (top === '.') line += `\x1b[0m\x1b[38;2;${rgb(bottom)}m▄`;
      else if (bottom === '.') line += `\x1b[0m\x1b[38;2;${rgb(top)}m▀`;
      else line += `\x1b[38;2;${rgb(top)};48;2;${rgb(bottom)}m▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines;
}

/**
 * The banner: the mascot, bushwhack's name and version beside it. Nothing when the output
 * is not a terminal (a pipe, a script) or when NO_COLOR asks for no colour.
 */
export function banner(version: string, output: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): string {
  if (!output.isTTY || env.NO_COLOR) return '';
  const beside = ['', '', `\x1b[1mbushwhack\x1b[22m \x1b[2mv${version}\x1b[22m`, '\x1b[2mweb chats on your folders — every change your yes\x1b[22m'];
  return `${mascotLines()
    .map((line, i) => `  ${line}   ${beside[i] ?? ''}`)
    .join('\n')}\n`;
}
