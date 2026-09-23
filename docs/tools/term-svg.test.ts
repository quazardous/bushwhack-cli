import { describe, it, expect } from 'vitest';
import { parse, render, scrub } from './term-svg.js';

describe('the terminal capture for the README', () => {
  it('replaces what is private, and refuses what is left', () => {
    expect(scrub('/home/someone/work/shop  code ABCD-EFGH-IJKL  www.meta.ai/a604c512-8806-4a0e-9d72-545838d37d8a')).toBe('~/work/shop  code XXXX-XXXX-XXXX  www.meta.ai/0000-…');
    expect(() => scrub('key QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY=')).toThrow(/private data left/);
  });

  it('draws colours, bold and block glyphs', () => {
    const svg = render(parse('\x1b[1mbold\x1b[0m \x1b[38;2;200;100;50m▀\x1b[0m <x>'));
    expect(svg).toContain('font-weight="bold"');
    expect(svg).toContain('fill="#c86432"');
    expect(svg).toContain('&lt;x&gt;');
  });
});
