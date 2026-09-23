import { describe, it, expect } from 'vitest';
import { Outbox } from './outbox.js';

describe('Outbox', () => {
  it('hands results only to their own conversation', () => {
    const box = new Outbox();
    const picture = { name: 's1', dataUrl: 'data:image/png;base64,AAAA' };
    box.hold('meta.ai/A', { text: 'results for A', images: [picture] });

    expect(box.deliverable('meta.ai/B')).toBeUndefined();
    expect(box.deliverable(null)).toBeUndefined();
    expect(box.deliverable('meta.ai/A')).toEqual({ conversation: 'meta.ai/A', text: 'results for A', images: [picture] });
  });

  it('keeps each conversation’s results apart, and drops them once delivered', () => {
    const box = new Outbox();
    box.hold('A', { text: 'a', images: [] });
    box.hold('B', { text: 'b', images: [] });
    box.delivered('A');

    expect(box.deliverable('A')).toBeUndefined();
    expect(box.deliverable('B')?.text).toBe('b');
    expect(box.waitingFor).toEqual(['B']);
  });
});
