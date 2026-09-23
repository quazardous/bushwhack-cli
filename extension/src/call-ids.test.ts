import { describe, it, expect } from 'vitest';
import { nextCallId } from './call-ids.js';

describe('the next free call id of a conversation', () => {
  it('goes on after the highest c<n> used, whatever the order; c1 when none', () => {
    expect(nextCallId([])).toBe(1);
    expect(nextCallId(['c2:ab', 'c10:cd', 'c9:ef', 'mine:12', '?:34'])).toBe(11);
  });
});
