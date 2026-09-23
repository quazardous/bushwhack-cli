import { describe, it, expect } from 'vitest';
import { ConversationOwners } from './conversation-owners.js';

describe('one tab acts for a conversation', () => {
  it('the first to report acts; a second tab on the same conversation does not', () => {
    const owners = new ConversationOwners();
    expect(owners.report(1, 'meta.ai/c1')).toBe(true);
    expect(owners.report(2, 'meta.ai/c1')).toBe(false);
    expect(owners.report(1, 'meta.ai/c1')).toBe(true);
    // Another conversation, and a fresh chat without an id yet: no contest.
    expect(owners.report(3, 'meta.ai/c2')).toBe(true);
    expect(owners.report(4, null)).toBe(true);
  });

  it('the tab brought to the front takes over', () => {
    const owners = new ConversationOwners();
    owners.report(1, 'meta.ai/c1');
    owners.report(2, 'meta.ai/c1');
    owners.activated(2);
    expect(owners.report(1, 'meta.ai/c1')).toBe(false);
    expect(owners.report(2, 'meta.ai/c1')).toBe(true);
    expect(owners.owner('meta.ai/c1')).toBe(2);
    // A tab showing nothing of ours takes nothing.
    owners.activated(9);
    expect(owners.owner('meta.ai/c1')).toBe(2);
  });

  it('when the acting tab closes or moves on, another showing it takes over', () => {
    const closed = new ConversationOwners();
    closed.report(1, 'meta.ai/c1');
    closed.report(2, 'meta.ai/c1');
    closed.forget(1);
    expect(closed.report(2, 'meta.ai/c1')).toBe(true);

    const moved = new ConversationOwners();
    moved.report(1, 'meta.ai/c1');
    moved.report(2, 'meta.ai/c1');
    expect(moved.report(1, 'meta.ai/c2')).toBe(true);
    expect(moved.report(2, 'meta.ai/c1')).toBe(true);
  });

  it('a tab opened in front onto the conversation acts from its first report', () => {
    const owners = new ConversationOwners();
    owners.report(1, 'meta.ai/c1');
    // Brought to the front before its page said what it shows.
    owners.activated(2);
    expect(owners.report(2, 'meta.ai/c1')).toBe(true);
    expect(owners.report(1, 'meta.ai/c1')).toBe(false);
    // And keeps it: being in front counts once, on arrival.
    owners.activated(1);
    owners.activated(3);
    expect(owners.report(1, 'meta.ai/c1')).toBe(true);
  });

  it('the tab in front, moving to a conversation open elsewhere, takes it over', () => {
    const owners = new ConversationOwners();
    owners.report(1, 'meta.ai/c1');
    owners.report(2, 'meta.ai/c2');
    owners.activated(2);
    expect(owners.report(2, 'meta.ai/c1')).toBe(true);
    expect(owners.report(1, 'meta.ai/c1')).toBe(false);
  });
});
