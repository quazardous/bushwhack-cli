import { describe, it, expect } from 'vitest';
import { StaleWatch } from './stale-watch.js';

const stamp = () => {
  let at: number | undefined;
  return { get: () => at, set: (n: number) => void (at = n) };
};

describe('an answer left blank on screen', () => {
  it('is worth a reload once it stays blank long enough', () => {
    const watch = new StaleWatch(stamp(), 20, 100);
    expect(watch.observe(true, 0)).toBe(false);
    expect(watch.observe(true, 10)).toBe(false);
    expect(watch.observe(true, 25)).toBe(true);
  });

  it('is not, when it shows in time', () => {
    const watch = new StaleWatch(stamp(), 20, 100);
    watch.observe(true, 0);
    expect(watch.observe(false, 15)).toBe(false);
    expect(watch.observe(true, 30)).toBe(false);
    expect(watch.observe(true, 45)).toBe(false);
  });

  it('is not reloaded again soon after — not even by the page that came back from the reload', () => {
    const kept = stamp();
    expect(new StaleWatch(kept, 20, 100).observe(true, 0) || new StaleWatch(kept, 0, 100).observe(true, 0)).toBe(true);
    const after = new StaleWatch(kept, 0, 100);
    expect(after.observe(true, 50)).toBe(false);
    expect(after.observe(true, 150)).toBe(true);
  });
});
