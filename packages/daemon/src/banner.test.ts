/**
 * The CLI's banner: the extension's mascot in the terminal, two pixels a character, and
 * nothing where colour is not wanted.
 */
import { describe, it, expect } from 'vitest';
import { SPRITE } from '@bushwhack/protocol';
import { banner, mascotLines } from './banner.js';

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('the banner', () => {
  it('draws the mascot two rows a line, each cell a half block or blank, colours reset at the end', () => {
    const lines = mascotLines();
    expect(lines).toHaveLength(SPRITE.length / 2);
    for (const line of lines) {
      expect(plain(line)).toMatch(/^[▀▄ ]{16}$/);
      expect(line.endsWith('\x1b[0m')).toBe(true);
    }
    // Two opaque pixels: the upper one's colour on the lower one's.
    expect(mascotLines(['OS', 'SO'])[0]).toContain('\x1b[38;2;32;20;11;48;2;240;192;138m▀');
    // Only the lower one: a lower half block, on nothing.
    expect(mascotLines(['.', 'O'])[0]).toContain('\x1b[38;2;32;20;11m▄');
  });

  it('names bushwhack and its version beside it, in a terminal only, and not under NO_COLOR', () => {
    expect(plain(banner('1.2.3', { isTTY: true }, {}))).toContain('bushwhack v1.2.3');
    expect(banner('1.2.3', { isTTY: false }, {})).toBe('');
    expect(banner('1.2.3', { isTTY: true }, { NO_COLOR: '1' })).toBe('');
  });
});
