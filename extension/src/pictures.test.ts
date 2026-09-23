import { describe, it, expect } from 'vitest';
import { REFUSED_NOTE, withoutPictures } from './pictures.js';

describe('a picture the chat refused', () => {
  it('is announced as not attached, with what to do instead', () => {
    const result = '```bushwhack-result\n---\nbushwhack-result: page:screenshot\nid: c12\nstatus: ok\nimage: attached\n---\na picture of the page, rendered from its DOM, is attached\n---end\n```';
    const told = withoutPictures(result);
    expect(told).toContain('image: not attached');
    expect(told).toContain(REFUSED_NOTE);
    expect(told).not.toMatch(/^image: attached$/m);
    // Nothing else changes.
    expect(withoutPictures('bushwhack-result: fs:read\nid: c1\nstatus: ok')).toBe('bushwhack-result: fs:read\nid: c1\nstatus: ok');
  });
});
