/**
 * The grammar's job is to never run a call the model has not finished writing, and to
 * carry file contents through untouched.
 */
import { describe, it, expect } from 'vitest';
import { scanCall, formatResult, RESULT_KEY } from './grammar.js';

const WRITE = ['---', 'bushwhack: fs:write', 'id: c2', 'path: src/a.js', '---', 'line 1', '', 'line 3', '---end'].join('\n');

describe('scanCall', () => {
  it('reads a call without a body', () => {
    expect(scanCall('---\nbushwhack: fs:read\nid: c1\npath: README.md\n---end\n')).toEqual({
      kind: 'call',
      call: { tool: 'fs:read', id: 'c1', args: { path: 'README.md' }, body: null },
    });
  });

  it('keeps the body raw, blank lines included', () => {
    const scanned = scanCall(WRITE);
    expect(scanned?.kind === 'call' && scanned.call.body).toBe('line 1\n\nline 3');
  });

  it('keeps a body line that looks like frontmatter', () => {
    const text = ['---', 'bushwhack: fs:write', 'id: c9', 'path: doc.md', '---', '---', 'title: x', '---', 'text', '---end'].join('\n');
    const scanned = scanCall(text);
    expect(scanned?.kind === 'call' && scanned.call.body).toBe('---\ntitle: x\n---\ntext');
  });

  it('treats a body without its end line as still streaming, not as a short file', () => {
    const truncated = WRITE.split('\n').slice(0, 6).join('\n');
    expect(scanCall(truncated)).toEqual({ kind: 'incomplete' });
  });

  it('ignores code that is not a call', () => {
    expect(scanCall('---\ntitle: a post\n---\nhello')).toBeUndefined();
    expect(scanCall('{"bushwhack":"fs:read"}')).toBeUndefined();
  });

  it('never reads a result block as a call', () => {
    expect(scanCall(`---\n${RESULT_KEY}: fs:read\nid: c1\nstatus: ok\n---end`)).toBeUndefined();
  });

  it('decodes a quoted value', () => {
    const scanned = scanCall('---\nbushwhack: fs:search\nid: s1\ntext: "  a \\"b\\""\n---end');
    expect(scanned?.kind === 'call' && scanned.call.args.text).toBe('  a "b"');
  });

  it('explains a missing id', () => {
    expect(scanCall('---\nbushwhack: fs:list\n---end')).toEqual({ kind: 'invalid', id: null, error: 'every call needs an "id"' });
  });

  it('refuses a repeated key rather than keeping either value', () => {
    const scanned = scanCall('---\nbushwhack: fs:read\nid: c1\npath: a\npath: b\n---end');
    expect(scanned).toMatchObject({ kind: 'invalid', id: 'c1' });
  });

  it('refuses text after the end line of a bodiless call', () => {
    expect(scanCall('---\nbushwhack: fs:read\nid: c1\n---end\nmore\n---end')).toMatchObject({ kind: 'invalid' });
  });
});

describe('a body written as a YAML block', () => {
  it('says where a body goes', () => {
    const scanned = scanCall('---\nbushwhack: fs:write\nid: c1\npath: a.js\ncontent: |\n  let a = 1;\n---end\n');
    expect(scanned).toMatchObject({ kind: 'invalid', id: 'c1' });
    expect(scanned && 'error' in scanned ? scanned.error : '').toMatch(/after the headers, a line ---, then the text as is/);
    // Any other line that is not a header keeps the plain message.
    const other = scanCall('---\nbushwhack: fs:read\nid: c2\nnot a header\n---end\n');
    expect(other && 'error' in other ? other.error : '').toBe('header line 4 is not "key: value": not a header');
  });
});

describe('formatResult', () => {
  it('reads back through the same grammar', () => {
    const text = formatResult({ tool: 'fs:read', id: 'c1', status: 'ok', meta: { lines: '1-2 of 2' }, content: 'a\nb' });
    const inner = text.split('\n').slice(1, -1).join('\n');

    const scanned = scanCall(inner, RESULT_KEY);

    expect(scanned).toEqual({
      kind: 'call',
      call: { tool: 'fs:read', id: 'c1', args: { status: 'ok', lines: '1-2 of 2' }, body: 'a\nb' },
    });
  });

  it('fences longer than any backtick run in the content', () => {
    const text = formatResult({ tool: 'fs:read', id: 'c1', status: 'ok', content: '````js\nx\n````' });
    expect(text.startsWith('`````bushwhack-result\n')).toBe(true);
    expect(text.endsWith('\n`````')).toBe(true);
  });

  it('quotes a meta value that would not read back as itself', () => {
    expect(formatResult({ tool: 'fs:read', id: 'c1', status: 'error', meta: { note: ' padded' } })).toContain('note: " padded"');
  });
});
