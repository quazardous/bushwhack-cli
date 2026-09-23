/**
 * The popup's project list. The popup refreshes it every two seconds; this keeps each
 * card in place and only updates its status, rebuilding a card when what it shows has
 * changed — so nothing moves under the operator's fingers.
 */
import type { DiscoveredSession, Links, TabInfo } from './messages.js';

export interface ListContext {
  links: Links;
  tab?: TabInfo;
  tabId?: number;
  pair(s: DiscoveredSession, code: string): void;
  bind(s: DiscoveredSession): void;
  forget(s: DiscoveredSession): void;
  focus(tabId: number): void;
  /** Open the project's app in a tab. */
  open(url: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function dot(state: boolean | undefined): HTMLElement {
  return el('span', { className: `dot ${state === undefined ? '' : state ? 'on' : 'off'}` });
}

/** The status line of a card: the only part of it that changes every refresh. */
function status(s: DiscoveredSession, ctx: ListContext): { state: boolean | undefined; text: string } {
  // Sessions connect on first use: paired but not yet connected is idle (grey), not down.
  const linked = s.paired && ctx.links.sessions[s.nodeId] ? true : undefined;
  return { state: linked, text: s.paired ? (linked ? ' · connected' : ' · idle') : ' · waiting for its service to be paired' };
}

/**
 * What a card shows besides its status. A card is rebuilt only when this changes — the
 * live refresh otherwise updates its status in place, so nothing moves under the
 * operator's fingers (a code being pasted, a button about to be clicked).
 */
function shapeOf(s: DiscoveredSession, ctx: ListContext): string {
  return JSON.stringify([s.session, s.folder, s.url, s.paired, s.chats, ctx.tab?.driver, ctx.tab?.bound?.nodeId, ctx.tabId]);
}

/** The end of a path, where the project's own folder is: the whole of it on hover. */
export function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : path;
}

/** A service, or a lone `bushwhack serve` session: what the pairing is with. */
const groupOf = (s: DiscoveredSession): string => s.service ?? s.nodeId;

function headerShape(s: DiscoveredSession): string {
  return JSON.stringify([groupOf(s), s.instance, s.port, s.paired]);
}

/**
 * A service's header. Pairing is between this browser and the service — once, for all its
 * projects — so the code field lives here, not on a project.
 */
function renderHeader(s: DiscoveredSession, ctx: ListContext): HTMLElement {
  const name = s.service ? `service ${s.instance ?? ''}`.trimEnd() : `bushwhack serve — ${s.session}`;
  const header = el('div', { className: 'service' }, el('b', {}, name), el('span', { className: 'muted' }, ` · port ${s.port}`));
  header.dataset.group = groupOf(s);
  header.dataset.shape = headerShape(s);
  if (s.paired) {
    header.append(el('span', { className: 'paired' }, ' · this browser is paired'));
    return header;
  }
  const code = el('input', { type: 'text', placeholder: s.service ? 'its pairing code (bushwhack list) — once, for all its projects' : 'pairing code', autocomplete: 'off' });
  const pair = el('button', { textContent: 'Pair' });
  pair.onclick = () => ctx.pair(s, code.value);
  header.append(el('div', { className: 'row' }, code, pair));
  return header;
}

function renderSession(s: DiscoveredSession, ctx: ListContext): HTMLElement {
  const title = el('div', {}, dot(undefined), el('b', {}, s.session), el('span', { className: 'muted status' }));
  const card = el('div', { className: 'session' }, title, el('div', { className: 'folder', title: s.folder }, shortPath(s.folder)));
  card.dataset.node = s.nodeId;
  card.dataset.shape = shapeOf(s, ctx);
  if (s.url) {
    const link = el('a', { href: s.url, textContent: s.url });
    link.onclick = (e) => {
      e.preventDefault();
      ctx.open(s.url!);
    };
    card.append(el('div', { className: 'app' }, 'app ', link));
  }
  if (!s.paired) return card;
  for (const chat of s.chats) {
    const name = chat.title ?? chat.conversation.replace(/^[^/]+\//, '').slice(0, 8);
    const line = el('div', { className: 'chat' });
    if (chat.tabId !== undefined) {
      const link = el('a', { href: '#', textContent: name, title: chat.conversation });
      link.onclick = (e) => {
        e.preventDefault();
        ctx.focus(chat.tabId!);
      };
      line.append('↳ ', link, chat.tabId === ctx.tabId ? ' (this tab)' : '');
    } else {
      line.append(`↳ ${name} — not open`);
    }
    card.append(line);
  }
  const row = el('div', { className: 'row' });
  if (ctx.tab?.driver && ctx.tab.bound?.nodeId !== s.nodeId && ctx.tabId !== undefined) {
    const bind = el('button', { className: 'primary', textContent: 'Use for this chat' });
    bind.onclick = () => ctx.bind(s);
    row.append(bind);
  }
  const forget = el('button', { textContent: 'Forget' });
  forget.onclick = () => ctx.forget(s);
  row.append(forget);
  card.append(row);
  return card;
}

/** Bring the list in line with `sessions`, touching only what changed. */
export function reconcile(list: HTMLElement, sessions: DiscoveredSession[], ctx: ListContext): void {
  if (sessions.length === 0) {
    list.className = 'muted';
    list.replaceChildren('None. Run `bushwhack add` in a project folder.');
    return;
  }
  list.className = '';
  const existing = new Map([...list.querySelectorAll<HTMLElement>(':scope > .session')].map((c) => [c.dataset.node!, c]));
  const headers = new Map([...list.querySelectorAll<HTMLElement>(':scope > .service')].map((h) => [h.dataset.group!, h]));
  // Each service's header, then its projects, in the order the services are found.
  const groups = new Map<string, DiscoveredSession[]>();
  for (const s of sessions) groups.set(groupOf(s), [...(groups.get(groupOf(s)) ?? []), s]);
  const cards = [...groups].flatMap(([group, members]) => {
    const oldHeader = headers.get(group);
    const header = oldHeader && oldHeader.dataset.shape === headerShape(members[0]) ? oldHeader : renderHeader(members[0], ctx);
    return [
      header,
      ...members.map((s) => {
        const old = existing.get(s.nodeId);
        const card = old && old.dataset.shape === shapeOf(s, ctx) ? old : renderSession(s, ctx);
        const { state, text } = status(s, ctx);
        card.querySelector('.dot')!.className = `dot ${state === undefined ? '' : state ? 'on' : 'off'}`;
        card.querySelector('.status')!.textContent = text;
        return card;
      }),
    ];
  });
  // Moving a node blurs what is focused in it: move nothing unless the list changed.
  const current = [...list.children];
  if (current.length !== cards.length || cards.some((c, i) => current[i] !== c)) list.replaceChildren(...cards);
}

