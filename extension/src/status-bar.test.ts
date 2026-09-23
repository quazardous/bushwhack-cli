// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { StatusBar, type HistoryEntry } from './status-bar.js';

const root = (): ShadowRoot => document.querySelector('[data-bushwhack-status]')!.shadowRoot!;

const HISTORY: HistoryEntry[] = [
  { at: 0, dir: 'up', id: 'c1', tool: 'fs:read', detail: 'README.md' },
  { at: 1, dir: 'down', id: 'c1', tool: 'fs:read', status: 'ok' },
  { at: 2, dir: 'up', id: 'c2', tool: 'fs:write', detail: 'a.txt' },
  { at: 3, dir: 'down', id: 'c2', tool: 'fs:write', status: 'denied' },
];

describe('StatusBar', () => {
  beforeEach(() => {
    document.documentElement.querySelectorAll('[data-bushwhack-status]').forEach((n) => n.remove());
  });

  it('shows the session, the state as a colour, and what went through each way', () => {
    const bar = new StatusBar(document);
    bar.show('demo', 'running 2 calls…', 'busy');
    bar.transit('up', 2);
    bar.transit('down', 1);

    expect(root().querySelector('.text')!.textContent).toBe('bushwhack · demo · running 2 calls…');
    expect((root().querySelector('.dot') as HTMLElement).dataset.tone).toBe('busy');
    expect(root().querySelector('.io')!.textContent).toBe('↑2↓1');
  });

  it('opens the history on click, newest first, and closes it on the next click', () => {
    const bar = new StatusBar(document);
    bar.show('demo', '', 'idle');
    bar.setHistory(HISTORY);
    const pill = root().querySelector('.pill') as HTMLElement;
    const panel = root().querySelector('.panel') as HTMLElement;
    expect(panel.hidden).toBe(true);

    pill.click();

    expect(panel.hidden).toBe(false);
    const rows = [...root().querySelectorAll('.row')].map((r) => r.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('c2fs:writedenied');
    expect(rows[3]).toContain('c1fs:read README.md');
    expect(root().querySelector('.io')!.textContent).toBe('↑2↓2');

    pill.click();
    expect(panel.hidden).toBe(true);
  });

  it('stays out of the page: its nodes live in a shadow root', () => {
    const bar = new StatusBar(document);
    bar.show('demo', '', 'idle');
    expect(document.querySelector('.pill')).toBeNull();
    expect(root().querySelector('.pill')).not.toBeNull();
  });

  it('counts all the calls and results given, not only the history it keeps', () => {
    const bar = new StatusBar(document);
    bar.show('demo', '', 'idle');
    bar.setHistory(HISTORY, { up: 180, down: 179 });
    expect(root().querySelector('.io')!.textContent).toBe('↑180↓179');
  });

  it('marks a terminal following the chat, in amber when it takes the approvals', () => {
    const bar = new StatusBar(document);
    bar.show('demo', '', 'idle');
    const term = (): HTMLElement => root().querySelector('.term') as HTMLElement;
    expect(term().hidden).toBe(true);
    bar.setTerminals({ count: 1, approvals: 'browser' });
    expect([term().hidden, term().classList.contains('approving'), term().textContent]).toEqual([false, false, '>_']);
    expect(term().title).toBe('a bushwhack terminal follows this chat — approvals are asked here, in the browser');
    bar.setTerminals({ count: 1, approvals: 'here' });
    expect([term().hidden, term().classList.contains('approving')]).toEqual([false, true]);
    expect(term().title).toBe('a bushwhack terminal follows this chat — approvals are asked there (--approve-here)');
    // `bushwhack approvals` elsewhere takes them: amber, with no terminal on this chat.
    bar.setTerminals({ count: 0, approvals: 'terminal' });
    expect([term().hidden, term().classList.contains('approving')]).toEqual([false, true]);
    bar.setTerminals({ count: 0, approvals: 'browser' });
    expect(term().hidden).toBe(true);
    bar.setTerminals(undefined);
    expect(term().hidden).toBe(true);
  });

  it('takes the place of a bar another copy of the script left behind', () => {
    const old = new StatusBar(document);
    old.show('demo', 'running 1 call…', 'busy');
    const fresh = new StatusBar(document);
    fresh.show('demo', '', 'idle');
    const bars = document.querySelectorAll('[data-bushwhack-status]');
    expect(bars).toHaveLength(1);
    expect(bars[0].shadowRoot!.querySelector('.text')!.textContent).toBe('bushwhack · demo');
  });
});
