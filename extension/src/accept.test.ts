import { describe, it, expect } from 'vitest';
import { accept } from './accept.js';

const runtime = { id: 'abc', panelPaths: ['/popup.html', '/frame.html'], hosts: ['meta.ai', 'gemini.google.com'] };

describe('accept', () => {
  it('knows the panel wherever it sits, and a chat page\'s top frame', () => {
    expect(accept({ id: 'abc', url: 'chrome-extension://abc/popup.html' }, runtime)).toBe('popup');
    // In a tab of its own; as the overlay's iframe over a chat, at a per-session address.
    expect(accept({ id: 'abc', url: 'chrome-extension://abc/popup.html', frameId: 0, tab: { id: 9 } }, runtime)).toBe('popup');
    expect(accept({ id: 'abc', url: 'chrome-extension://d1a2b3/frame.html?tab=3', frameId: 12, tab: { id: 3, url: 'https://www.meta.ai/prompt/1' } }, runtime)).toBe('popup');
    expect(accept({ id: 'abc', url: 'https://www.meta.ai/prompt/1', frameId: 0, tab: { id: 3, url: 'https://www.meta.ai/prompt/1' } }, runtime)).toBe('content');
    expect(accept({ id: 'abc', url: 'https://gemini.google.com/app/x', frameId: 0, tab: { id: 4 } }, runtime)).toBe('content');
  });

  it('drops the rest: another extension, a subframe, a site no driver claims, another extension page', () => {
    expect(accept({ id: 'other', url: 'chrome-extension://abc/popup.html' }, runtime)).toBeUndefined();
    expect(accept({ id: 'abc', url: 'https://www.meta.ai/embed', frameId: 7, tab: { id: 3 } }, runtime)).toBeUndefined();
    expect(accept({ id: 'abc', url: 'https://evil-meta.ai.example/x', frameId: 0, tab: { id: 3 } }, runtime)).toBeUndefined();
    expect(accept({ id: 'abc', url: 'http://shop.localhost/', frameId: 0, tab: { id: 5 } }, runtime)).toBeUndefined();
    expect(accept({ id: 'abc', url: 'chrome-extension://abc/other.html' }, runtime)).toBeUndefined();
    expect(accept({ id: 'abc', url: 'chrome-extension://abc/other.html', frameId: 4, tab: { id: 3 } }, runtime)).toBeUndefined();
    // A page of the chat's site claiming the panel's path is still the site.
    expect(accept({ id: 'abc', url: 'https://www.meta.ai/popup.html', frameId: 0, tab: { id: 3 } }, runtime)).toBe('content');
    expect(accept({ id: 'abc', url: 'https://www.meta.ai/popup.html', frameId: 2, tab: { id: 3 } }, runtime)).toBeUndefined();
  });
});
