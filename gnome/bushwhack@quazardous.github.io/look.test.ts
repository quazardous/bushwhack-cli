/**
 * The GNOME indicator's wording: the same as the Windows tray's, for the same
 * `bushwhack list --json`.
 */
import { describe, it, expect } from 'vitest';
import { modeChoices, projectLabel, trayLook, trayNews } from './look.js';

const list = {
  mode: 'octopod',
  code: 'ABCD-EFGH-IJKL',
  browsers: [{ node: 'ext:1' }],
  projects: [
    { session: 'shop', folder: '/w/shop', chat: { chat: 'Gemini' } },
    { session: 'notes', folder: '/w/notes' },
  ],
};

describe('the GNOME indicator', () => {
  it('sums the service up, or says it is stopped', () => {
    expect(trayLook(list)).toEqual({ up: true, line: '2 projects — 1 chat live (octopod)' });
    expect(trayLook({ ...list, browsers: [], projects: [list.projects[1]] })).toEqual({ up: true, line: '1 project — no chat open, no browser paired (octopod)' });
    expect(trayLook(null)).toEqual({ up: false, line: 'The bushwhack service is not running' });
  });

  it('names each project with the chat it is live in', () => {
    expect(projectLabel(list.projects[0])).toBe('shop — live in Gemini');
    expect(projectLabel(list.projects[1])).toBe('notes — no chat open');
    expect(projectLabel({ session: 'x', chat: {} })).toBe('x — live in a web chat');
  });

  it('notifies only when the service stops or comes back', () => {
    const up = trayLook(list);
    const down = trayLook(null);
    expect(trayNews(null, up)).toBeNull();
    expect(trayNews(up, down)).toBe('The bushwhack service stopped');
    expect(trayNews(down, up)).toBe('The bushwhack service is back');
    expect(trayNews(up, up)).toBeNull();
  });

  it('offers the other mode, octopod only when it is installed', () => {
    const [standalone, octopod] = modeChoices('standalone', false);
    expect(standalone).toMatchObject({ checked: true, enabled: false });
    expect(octopod).toMatchObject({ checked: false, enabled: false, label: expect.stringContaining('npm i -g @quazardous/octopod') });
    expect(modeChoices('standalone', true)[1]).toMatchObject({ enabled: true });
  });
});
