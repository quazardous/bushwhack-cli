/**
 * A copy checked against the render. meta.ai's copy dropped `[t1]` from an fs:edit's
 * REPLACE (2026-09-23): the edit arrived a no-op, and an earlier fs:write had put a syntax
 * error in the file. Such a call is refused; a render that lacks lines is not taken for it.
 */
import { describe, it, expect } from 'vitest';
import { callsInMarkdown, crossCheck } from './engine.js';

const call = (id: string, replace: string) =>
  `---\nbushwhack: fs:edit\nid: ${id}\npath: index.html\n---\nSEARCH\n  db.transplants=;\nREPLACE\n  ${replace}\n---end`;
const found = (text: string) => callsInMarkdown('```bushwhack\n' + text + '\n```');

describe('a copy checked against the render', () => {
  it('refuses a call the copy altered, saying what was lost', () => {
    const [checked] = crossCheck(found(call('c358', 'db.transplants=;')), found(call('c358', 'db.transplants=[t1];')));
    expect(checked).toMatchObject({ kind: 'invalid', id: 'c358', refused: true, error: expect.stringContaining('`[t1]`') });
    expect(checked.kind === 'invalid' && checked.error).toMatch(/Nothing was run.*\[ t1 \]/);
  });

  it('keeps the copy when the render only lacks lines or spaces, or is not there', () => {
    const copy = found('---\nbushwhack: fs:write\nid: c1\npath: a.txt\n---\nkeep\n=======\nthis\n---end');
    const render = found('---\nbushwhack: fs:write\nid: c1\npath: a.txt\n---\nkeep\nthis\n---end');
    expect(crossCheck(copy, render)).toEqual(copy);
    expect(crossCheck(copy, [])).toEqual(copy);
    const spaced = found('---\nbushwhack: fs:write\nid: c1\npath: a.txt\n---\nkeep   =======    this\n---end');
    expect(crossCheck(copy, spaced)[0].kind).toBe('call');
  });

  it('does not guess when the two differ otherwise', () => {
    const copy = found(call('c9', 'a=1;'));
    expect(crossCheck(copy, found(call('c9', 'b=22;')))).toEqual(copy);
  });
});
