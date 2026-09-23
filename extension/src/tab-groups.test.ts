import { describe, it, expect } from 'vitest';
import { afterMove, appOwner, colorOf, shouldJoin, shouldLeave, type GroupState } from './tab-groups.js';

const empty: GroupState = { groups: {}, placed: {}, optedOut: [] };

describe('tab groups', () => {
  it('groups an ungrouped tab, and not one already in the session\'s group', () => {
    expect(shouldJoin({ id: 1, groupId: -1 }, undefined, empty)).toBe(true);
    expect(shouldJoin({ id: 1, groupId: -1 }, 7, empty)).toBe(true);
    expect(shouldJoin({ id: 1, groupId: 7 }, 7, empty)).toBe(false);
  });

  it('never moves a tab out of a group of the operator\'s', () => {
    expect(shouldJoin({ id: 1, groupId: 9 }, 7, empty)).toBe(false);
    expect(shouldJoin({ id: 1, groupId: 9 }, undefined, empty)).toBe(false);
  });

  it('leaves alone, for good, a tab the operator took out of the group', () => {
    const placed = { ...empty, placed: { 1: 7 } };
    const out = afterMove(placed, 1, -1);
    expect(out.optedOut).toEqual([1]);
    expect(out.placed).toEqual({});
    expect(shouldJoin({ id: 1, groupId: -1 }, 7, out)).toBe(false);
    // Its own group change, or a tab never placed: nothing to note.
    expect(afterMove(placed, 1, 7)).toBe(placed);
    expect(afterMove(placed, 2, -1)).toBe(placed);
  });

  it('moves a chat tab to the group of the chat it now shows, and out when it shows an unbound one', () => {
    // Put by this module in project A's group (7): it follows the chat to B's group (8).
    const placed = { ...empty, placed: { 1: 7 } };
    expect(shouldJoin({ id: 1, groupId: 7 }, 8, placed)).toBe(true);
    expect(shouldLeave({ id: 1, groupId: 7 }, placed)).toBe(true);
    // A group of the operator's, a tab never placed, or one they took out: left alone.
    expect(shouldJoin({ id: 1, groupId: 9 }, 8, placed)).toBe(false);
    expect(shouldLeave({ id: 1, groupId: 9 }, placed)).toBe(false);
    expect(shouldLeave({ id: 2, groupId: 7 }, placed)).toBe(false);
    expect(shouldLeave({ id: 1, groupId: -1 }, placed)).toBe(false);
    expect(shouldLeave({ id: 1, groupId: 7 }, { ...placed, optedOut: [1] })).toBe(false);
  });

  it('knows a project\'s app by its address, whatever the port, and nothing else', () => {
    const projects = [{ session: 'hello-site' }, { session: 'site' }];
    expect(appOwner('http://hello-site.localhost/', projects)).toBe(projects[0]);
    expect(appOwner('http://hello-site.localhost:18490/a?b', projects)).toBe(projects[0]);
    expect(appOwner('http://api.hello-site.localhost/', projects)).toBe(projects[0]);
    expect(appOwner('http://site.localhost/', projects)).toBe(projects[1]);
    expect(appOwner('http://other-site.localhost/', projects)).toBeUndefined();
    expect(appOwner('https://hello-site.localhost.evil.example/', projects)).toBeUndefined();
    expect(appOwner('chrome://newtab', projects)).toBeUndefined();
  });

  it('gives each project a stable colour', () => {
    expect(colorOf('hello-site')).toBe(colorOf('hello-site'));
    expect(['blue', 'green', 'purple', 'cyan', 'orange', 'pink', 'red', 'yellow', 'grey']).toContain(colorOf('notes-app'));
  });
});
