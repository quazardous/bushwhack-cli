/**
 * The bridge's status bar in the chat page: what it is doing, in colour, with ↑ / ↓
 * counters that flash as calls go out and results come back. A click opens the history
 * of what went through; another click closes it.
 *
 * Lives in a shadow root: the chat's own CSS cannot reach it, and it cannot leak into
 * the chat. It is never part of the transcript or the composer.
 */
export type Tone = 'idle' | 'busy' | 'wait' | 'error';

/** The `bushwhack` terminals following the chat, and where its approvals go. */
export interface Terminals {
  count: number;
  approvals: 'here' | 'terminal' | 'browser';
}

/** The terminal mark: shown when one follows the chat or takes its approvals; coloured when approvals go to a terminal. */
export function terminalMark(t: Terminals | undefined): { shown: boolean; approving: boolean; title: string } {
  if (!t || (t.count === 0 && t.approvals === 'browser')) return { shown: false, approving: false, title: '' };
  const follows = t.count === 0 ? 'no terminal follows this chat' : t.count === 1 ? 'a bushwhack terminal follows this chat' : `${t.count} bushwhack terminals follow this chat`;
  const where =
    t.approvals === 'here' ? 'approvals are asked there (--approve-here)' : t.approvals === 'terminal' ? 'approvals are asked in the bushwhack approvals terminal' : 'approvals are asked here, in the browser';
  return { shown: true, approving: t.approvals !== 'browser', title: `${follows} — ${where}` };
}

export interface HistoryEntry {
  at: number;
  dir: 'up' | 'down';
  id: string | null;
  tool: string;
  /** The call's main argument (a path), or a result's note. */
  detail?: string;
  status?: string;
  replay?: boolean;
}

const COLORS: Record<Tone, string> = { idle: '#16a34a', busy: '#2563eb', wait: '#d97706', error: '#dc2626' };

const STYLE = `
:host { all: initial; }
.bar { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; font: 12px/1.5 system-ui, sans-serif;
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px; color: #f9fafb; }
.pill { display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-radius: 999px; background: #1f2937;
  box-shadow: 0 1px 4px rgb(0 0 0 / .3); cursor: pointer; user-select: none; max-width: 60vw; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.term { flex: none; padding: 0 5px; border-radius: 4px; font: 600 11px/1.4 ui-monospace, monospace; color: #9ca3af; background: #374151; }
.term[hidden] { display: none; }
.term.approving { color: #1f2937; background: #fbbf24; }
.io { display: flex; gap: 6px; font-variant-numeric: tabular-nums; color: #9ca3af; flex: none; }
.io span { transition: color .15s; }
.io .flash-up { color: #60a5fa; }
.io .flash-down { color: #4ade80; }
.panel { width: min(880px, 90vw); max-height: 50vh; overflow: auto; background: #111827; border-radius: 10px;
  box-shadow: 0 4px 16px rgb(0 0 0 / .4); padding: 8px 0; }
.panel[hidden] { display: none; }
.panel h1 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: #9ca3af; margin: 0 12px 6px; }
.row { display: grid; grid-template-columns: auto auto auto 1fr auto; gap: 8px; padding: 2px 12px; align-items: baseline; }
.row:hover { background: #1f2937; }
.time { color: #6b7280; font-variant-numeric: tabular-nums; }
.arrow.up { color: #60a5fa; } .arrow.down { color: #4ade80; }
.id { color: #d1d5db; font-family: ui-monospace, monospace; }
.what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.what .detail { color: #9ca3af; }
.status.ok { color: #4ade80; } .status.error { color: #f87171; } .status.denied { color: #fbbf24; }
.empty { color: #6b7280; padding: 2px 12px; }
`;

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export class StatusBar {
  private host: HTMLElement | undefined;
  private parts: { dot: HTMLElement; text: HTMLElement; term: HTMLElement; up: HTMLElement; down: HTMLElement; panel: HTMLElement; list: HTMLElement; title: HTMLElement } | undefined;
  private counts = { up: 0, down: 0 };
  private history: HistoryEntry[] = [];
  private session = '';

  constructor(private readonly doc: Document) {}

  private mount(): NonNullable<StatusBar['parts']> {
    if (this.parts && this.host?.isConnected) return this.parts;
    const d = this.doc;
    this.host = d.createElement('div');
    this.host.setAttribute('data-bushwhack-status', '');
    const root = this.host.attachShadow({ mode: 'open' });
    const style = d.createElement('style');
    style.textContent = STYLE;
    const el = (tag: string, cls: string, text = ''): HTMLElement => {
      const node = d.createElement(tag);
      node.className = cls;
      node.textContent = text;
      return node;
    };
    const bar = el('div', 'bar');
    const panel = el('div', 'panel');
    panel.hidden = true;
    const title = el('h1', '', 'history');
    const list = el('div', 'list');
    panel.append(title, list);
    const pill = el('div', 'pill');
    pill.setAttribute('role', 'button');
    pill.title = 'bushwhack — click for the history';
    const dot = el('span', 'dot');
    const text = el('span', 'text');
    const term = el('span', 'term', '>_');
    term.hidden = true;
    const io = el('span', 'io');
    const up = el('span', '', '↑0');
    const down = el('span', '', '↓0');
    io.append(up, down);
    pill.append(dot, text, term, io);
    pill.addEventListener('click', () => this.toggle());
    bar.append(panel, pill);
    root.append(style, bar);
    // In <body>, and only ever after the page has hydrated (the content script waits for
    // the chat's own editor): a foreign node in <html> while React hydrates the document
    // derailed meta.ai's hydration, leaving the page without its editor.
    // One bar per page: a copy of the script the extension left behind (reloaded under the
    // page) may still have one up, frozen on what it was doing — it would hide this one.
    for (const other of d.querySelectorAll('[data-bushwhack-status]')) if (other !== this.host) other.remove();
    d.body.appendChild(this.host);
    this.parts = { dot, text, term, up, down, panel, list, title };
    this.renderCounts();
    this.renderHistory();
    return this.parts;
  }

  show(session: string, text: string, tone: Tone): void {
    const parts = this.mount();
    this.session = session;
    parts.text.textContent = `bushwhack · ${session}${text ? ` · ${text}` : ''}`;
    parts.dot.style.background = COLORS[tone];
    parts.dot.dataset.tone = tone;
    parts.title.textContent = `history — ${session}`;
  }

  /** The terminals following the chat: the `>_` mark, amber when approvals go to a terminal. */
  setTerminals(t: Terminals | undefined): void {
    const parts = this.mount();
    const mark = terminalMark(t);
    parts.term.hidden = !mark.shown;
    parts.term.classList.toggle('approving', mark.approving);
    parts.term.title = mark.title;
  }

  /** Calls went out (`up`) or results came back (`down`): count them and flash. */
  transit(dir: 'up' | 'down', count: number): void {
    const parts = this.mount();
    this.counts[dir] += count;
    this.renderCounts();
    const node = dir === 'up' ? parts.up : parts.down;
    node.classList.add(`flash-${dir}`);
    setTimeout(() => node.classList.remove(`flash-${dir}`), 1200);
  }

  /**
   * The conversation's latest history, and how many calls and results it has had in all:
   * the history keeps the last ones only, so counting it would stop at its size.
   */
  setHistory(entries: HistoryEntry[], totals?: { up: number; down: number }): void {
    this.history = entries;
    this.counts = totals ?? {
      up: entries.filter((e) => e.dir === 'up').length,
      down: entries.filter((e) => e.dir === 'down').length,
    };
    if (this.parts) {
      this.renderCounts();
      this.renderHistory();
    }
  }

  get expanded(): boolean {
    return this.parts ? !this.parts.panel.hidden : false;
  }

  toggle(): void {
    const parts = this.mount();
    parts.panel.hidden = !parts.panel.hidden;
    if (!parts.panel.hidden) this.renderHistory();
  }

  remove(): void {
    this.host?.remove();
    this.host = undefined;
    this.parts = undefined;
  }

  private renderCounts(): void {
    if (!this.parts) return;
    this.parts.up.textContent = `↑${this.counts.up}`;
    this.parts.down.textContent = `↓${this.counts.down}`;
  }

  private renderHistory(): void {
    if (!this.parts) return;
    const d = this.doc;
    const rows = [...this.history].reverse().map((entry) => {
      const row = d.createElement('div');
      row.className = 'row';
      const cell = (cls: string, text: string): HTMLElement => {
        const node = d.createElement('span');
        node.className = cls;
        node.textContent = text;
        return node;
      };
      const what = cell('what', entry.tool);
      if (entry.detail) what.append(' ', cell('detail', entry.detail));
      row.append(
        cell('time', time(entry.at)),
        cell(`arrow ${entry.dir}`, entry.dir === 'up' ? '↑' : '↓'),
        cell('id', entry.id ?? '?'),
        what,
        cell(`status ${entry.status ?? ''}`, entry.status ? `${entry.status}${entry.replay ? ' (replay)' : ''}` : ''),
      );
      return row;
    });
    this.parts.list.replaceChildren(...(rows.length ? rows : [Object.assign(d.createElement('div'), { className: 'empty', textContent: 'nothing yet' })]));
  }
}
