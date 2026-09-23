import { describe, it, expect } from 'vitest';
import { bindArgs, type ToolSpec } from './tools.js';
import { renderManifest } from './manifest.js';

const READ: ToolSpec = {
  name: 'fs:read',
  summary: 'Read a file.',
  approval: false,
  params: {
    path: { type: 'path', description: 'the file', required: true },
    from: { type: 'int', description: 'first line', min: 1, max: 1_000_000, default: 1 },
  },
};

const WRITE: ToolSpec = {
  name: 'fs:write',
  summary: 'Write a file.',
  approval: true,
  params: { path: { type: 'path', description: 'the file', required: true } },
  body: { description: 'the contents', required: true, maxBytes: 8 },
};

describe('bindArgs', () => {
  it('types values and fills defaults', () => {
    expect(bindArgs(READ, { path: 'a.txt' }, null)).toEqual({ args: { path: 'a.txt', from: 1 }, body: null });
    expect(bindArgs(READ, { path: 'a.txt', from: '7' }, null).args.from).toBe(7);
  });

  it('refuses an unknown key instead of dropping it', () => {
    expect(() => bindArgs(READ, { path: 'a', mode: 'x' }, null)).toThrow(/unknown parameter "mode"/);
    // A tool with a body says where the text goes: the likeliest mistake is a header key.
    expect(() => bindArgs(WRITE, { path: 'a', content: 'x' }, null)).toThrow(/and a body \(the contents\): after a second --- line, up to ---end/);
    expect(() => bindArgs(READ, { path: 'a', mode: 'x' }, null)).not.toThrow(/body/);
    expect(() => bindArgs(WRITE, { path: 'a' }, null)).toThrow(/needs a body \(the contents\): after the header, a second --- line/);
  });

  it('refuses out-of-range and malformed integers', () => {
    expect(() => bindArgs(READ, { path: 'a', from: '0' }, null)).toThrow(/between/);
    expect(() => bindArgs(READ, { path: 'a', from: '1e3' }, null)).toThrow(/integer/);
  });

  it('requires what is required', () => {
    expect(() => bindArgs(READ, {}, null)).toThrow(/"path" is required/);
    expect(() => bindArgs(WRITE, { path: 'a' }, null)).toThrow(/needs a body/);
  });

  it('refuses a body the tool does not take, and one that is too big', () => {
    expect(() => bindArgs(READ, { path: 'a' }, 'text')).toThrow(/takes no body/);
    expect(() => bindArgs(WRITE, { path: 'a' }, 'é'.repeat(5))).toThrow(/10 bytes/);
  });

  it('keeps an empty body as an empty file', () => {
    expect(bindArgs(WRITE, { path: 'a' }, '').body).toBe('');
  });
});

describe('renderManifest', () => {
  it('lists every tool with its parameters and approval', () => {
    const text = renderManifest([READ, WRITE], { session: 'demo' });
    expect(text).toContain('### `fs:read`\n');
    expect(text).toContain("### `fs:write` — needs the operator's approval");
    expect(text).toContain('`from` (integer 1–1000000, default 1)');
    expect(text).toContain('body (required, ≤8 bytes)');
  });
});

describe('renderManifest with a chat prompt', () => {
  it('puts the preamble after the introduction and the notes after the rules', () => {
    const text = renderManifest([READ], { session: 'demo', chat: { title: 'Meta AI', preamble: 'You are Meta AI.', notes: ['a', 'b'] } });
    expect(text.indexOf('You are Meta AI.')).toBeGreaterThan(text.indexOf('You can act on'));
    expect(text.indexOf('## In Meta AI')).toBeGreaterThan(text.indexOf('Rules:'));
    expect(text.indexOf('## In Meta AI')).toBeLessThan(text.indexOf('## Tools'));
    expect(text).toContain('## In Meta AI\n\n- a\n- b\n');
  });
});
