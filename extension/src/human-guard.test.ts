// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { HumanGuard, QUIET_MS } from './human-guard.js';

function clock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('HumanGuard', () => {
  it('pauses for a few seconds after a person types, then lets go', () => {
    const c = clock();
    const guard = new HumanGuard(c.now);
    expect(guard.typing()).toBe(false);

    guard.note();
    c.advance(QUIET_MS - 1);
    expect(guard.typing()).toBe(true);
    c.advance(1);
    expect(guard.typing()).toBe(false);
  });

  it("ignores the bridge's own synthetic events — only trusted input is a person", () => {
    const guard = new HumanGuard();
    guard.watch(document);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    document.body.dispatchEvent(new Event('paste', { bubbles: true }));
    expect(guard.typing()).toBe(false);
  });

  it('tells whether a person touched the page after results went in', () => {
    const c = clock();
    const guard = new HumanGuard(c.now);
    const written = c.now();
    c.advance(100);
    expect(guard.touchedSince(written)).toBe(false);
    guard.note();
    expect(guard.touchedSince(written)).toBe(true);
  });
});
