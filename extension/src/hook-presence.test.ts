// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { answerHookPings, hookPresent } from './hook-presence.js';

describe('hookPresent', () => {
  it('says no on a page without the hook — the copy button must not be clicked', () => {
    const page = document.implementation.createHTMLDocument('chat');
    expect(hookPresent(page)).toBe(false);
  });

  it('says yes once the hook answers', () => {
    const page = document.implementation.createHTMLDocument('chat');
    answerHookPings(page);
    expect(hookPresent(page)).toBe(true);
  });
});
