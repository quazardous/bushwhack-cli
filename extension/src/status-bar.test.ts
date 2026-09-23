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
});
