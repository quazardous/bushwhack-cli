/**
 * The popup's project list. The popup refreshes it every two seconds; this keeps each
 * card in place and only updates its status, rebuilding a card when what it shows has
 * changed — so nothing moves under the operator's fingers.
 */
import type { DiscoveredSession, Links, TabInfo, TerminalItem } from './messages.js';

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
  /** Show a project's detail view. */
  details(s: DiscoveredSession): void;
  /** Close a terminal following the project's chat — asked first. */
  closeTerminal(s: DiscoveredSession, terminal: string): void;
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
  return JSON.stringify([s.session, s.folder, s.url, s.paired, s.chats, s.terminals, s.approvals, ctx.tab?.driver, ctx.tab?.bound?.nodeId, ctx.tabId]);
}

/** The end of a path, where the project's own folder is: the whole of it on hover. */
export function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : path;
}

/** A service, or a lone `bushwhack serve` session: what the pairing is with. */
const groupOf = (s: DiscoveredSession): string => s.service ?? s.nodeId;

function headerShape(members: DiscoveredSession[]): string {
  const s = members[0];
  return JSON.stringify([groupOf(s), s.instance, s.port, s.paired, members.length]);
}

/**
 * Forgetting is the service's, like pairing — every one of its projects at once — and it
 * is asked first, in the panel: a browser dialog would freeze the chat page under it.
 */
function askForget(header: HTMLElement, members: DiscoveredSession[], ctx: ListContext): void {
  if (header.querySelector('.confirm')) return;
  const s = members[0];
  const what = s.service ? `the pairing with service ${s.instance ?? ''}`.trimEnd() : `the pairing with ${s.session}`;
  const projects = s.service ? `its ${members.length} project${members.length === 1 ? '' : 's'}` : 'this project';
  const yes = el('button', { className: 'danger', textContent: 'Forget' });
  const no = el('button', { textContent: 'Cancel' });
  const box = el(
    'div',
    { className: 'confirm', role: 'alertdialog' },
    el('div', {}, el('b', {}, `Forget ${what}?`), ` This browser stops talking to it: ${projects} leave this list, and the chats bound to ${s.service ? 'them' : 'it'} are unbound, until you pair again with its code.`),
    el('div', { className: 'row' }, yes, no),
  );
  yes.onclick = () => {
    box.remove();
    ctx.forget(s);
  };
  no.onclick = () => box.remove();
  header.append(box);
  no.focus();
}

/**
 * A service's header. Pairing is between this browser and the service — once, for all its
 * projects — so the code field lives here, not on a project.
 */
function renderHeader(members: DiscoveredSession[], ctx: ListContext): HTMLElement {
  const s = members[0];
  const name = s.service ? `service ${s.instance ?? ''}`.trimEnd() : `bushwhack serve — ${s.session}`;
  const header = el('div', { className: 'service' }, el('b', {}, name), el('span', { className: 'muted' }, ` · port ${s.port}`));
  header.dataset.group = groupOf(s);
  header.dataset.shape = headerShape(members);
  if (s.paired) {
    const forget = el('button', { className: 'quiet', textContent: 'Forget…', title: 'forget this pairing: every project of this service' });
    forget.onclick = () => askForget(header, members, ctx);
    header.append(el('span', { className: 'paired' }, ' · this browser is paired'), forget);
    return header;
  }
  // What to do first: the field stands out, and takes the keyboard when nothing else has it.
  const code = el('input', { type: 'text', className: 'pair-code', placeholder: s.service ? 'its pairing code (bushwhack list) — once, for all its projects' : 'pairing code', autocomplete: 'off', spellcheck: false });
  const pair = el('button', { className: 'primary', textContent: 'Pair' });
  pair.onclick = () => ctx.pair(s, code.value);
  code.onkeydown = (e) => {
    if (e.key === 'Enter') ctx.pair(s, code.value);
  };
  header.append(el('div', { className: 'row' }, code, pair));
  queueMicrotask(() => {
    if (code.isConnected && (!document.activeElement || document.activeElement === document.body)) code.focus();
  });
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
  const terms = terminalSummary(s);
  if (terms) card.append(el('div', { className: 'terminals' }, el('span', { className: `term${s.approvals === 'here' ? ' approving' : ''}` }, '>_'), ` ${terms}`));
  const row = el('div', { className: 'row' });
  if (ctx.tab?.driver && ctx.tab.bound?.nodeId !== s.nodeId && ctx.tabId !== undefined) {
    const bind = el('button', { className: 'primary', textContent: 'Use for this chat' });
    bind.onclick = () => ctx.bind(s);
    row.append(bind);
  }
  const details = el('button', { className: 'quiet', textContent: 'Details' });
  details.onclick = () => ctx.details(s);
  row.append(details);
  card.append(row);
  return card;
}

/** The terminals following a project's chat, in a few words — undefined when there are none. */
export function terminalSummary(s: Pick<DiscoveredSession, 'terminals'>): string | undefined {
  const list = s.terminals ?? [];
  if (list.length === 0) return undefined;
  const n = list.length === 1 ? '1 terminal' : `${list.length} terminals`;
  return list.some((t) => t.approves) ? `${n} · approvals asked there` : n;
}

function since(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  return minutes < 1 ? 'just opened' : `open for ${minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`}`;
}

/** A power symbol, drawn: no font carries one everywhere. */
function powerIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 3v9', 'M6.3 6.8a8 8 0 1 0 11.4 0']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * Close a terminal: a red power button, clicked twice. The first click arms it and says what
 * a second one does, beside it; left alone a few seconds, it disarms.
 */
function closeButton(s: DiscoveredSession, t: TerminalItem, ctx: ListContext): HTMLElement {
  const button = el('button', { className: 'power', title: 'Close this terminal' });
  button.setAttribute('aria-label', 'Close this terminal');
  button.append(powerIcon());
  const note = el('span', { className: 'arm-note' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = (): void => {
    clearTimeout(timer);
    button.classList.remove('armed');
    note.textContent = '';
  };
  button.onclick = () => {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      note.textContent = `click again to close it${t.approves ? ' — its approvals then go to the browser' : ''}`;
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    ctx.closeTerminal(s, t.id);
  };
  return el('span', { className: 'close' }, note, button);
}

/** The head of a view beside the projects: the way back, a title, a line under it. */
export function asideHead(title: string, sub: string, back: () => void): HTMLElement {
  const backButton = el('button', { textContent: '← Projects', title: 'back to the projects (Escape)' });
  backButton.onclick = back;
  return el('div', { className: 'aside-head' }, backButton, el('div', {}, el('h1', {}, title), el('div', { className: 'sub', title: sub }, sub)));
}

function section(title: string, ...children: (Node | string)[]): HTMLElement {
  return el('section', { className: 'section' }, el('h4', {}, title), ...children);
}

/**
 * One project in full, beside the list: its app and chats, where its approvals go, and the
 * terminals following its chat — each can be closed from here, after a confirmation.
 */
export function renderDetail(s: DiscoveredSession, ctx: ListContext, back: () => void): HTMLElement {
  const view = el('div', { className: 'detail' }, asideHead(s.session, s.folder, back));
  view.dataset.shape = shapeOf(s, ctx);

  const where = section('App and chats');
  if (s.url) {
    const link = el('a', { href: s.url, textContent: s.url });
    link.onclick = (e) => {
      e.preventDefault();
      ctx.open(s.url!);
    };
    where.append(el('div', { className: 'line' }, 'app ', link));
  }
  if (s.chats.length === 0) where.append(el('div', { className: 'line muted' }, 'no chat bound yet — open one, then Use for this chat'));
  for (const chat of s.chats) {
    const line = el('div', { className: 'line' });
    if (chat.tabId !== undefined) {
      const link = el('a', { href: '#', textContent: chat.title ?? chat.conversation, title: chat.conversation });
      link.onclick = (e) => {
        e.preventDefault();
        ctx.focus(chat.tabId!);
      };
      line.append('↳ ', link);
    } else {
      line.append(`↳ ${chat.title ?? chat.conversation} `, el('span', { className: 'muted' }, '— not open'));
    }
    where.append(line);
  }

  const approvals = section(
    'Approvals',
    s.approvals === 'here'
      ? el('div', { className: 'line' }, 'Asked in a terminal below, started with ', el('code', {}, '--approve-here'), '.')
      : s.approvals === 'terminal'
        ? el('div', { className: 'line' }, 'Asked in the ', el('code', {}, 'bushwhack approvals'), ' terminal.')
        : el('div', { className: 'line' }, 'Asked in this browser: a notification per change, the whole diff on a click.'),
  );

  const list = s.terminals ?? [];
  const terminals = section(`Terminals${list.length ? ` · ${list.length}` : ''}`);
  terminals.classList.add('wide');
  if (list.length === 0) terminals.append(el('div', { className: 'line muted' }, 'None follows this chat. bushwhack, in the project\'s folder, opens one.'));
  for (const t of list) {
    const row = el(
      'div',
      { className: 'terminal' },
      el('span', { className: `term${t.approves ? ' approving' : ''}` }, '>_'),
      el('div', { className: 'what' }, el('span', {}, t.label ?? 'a terminal (an older bushwhack)'), el('small', {}, `${t.approves ? 'takes the approvals' : 'follows the chat'}${t.since ? ` · ${since(t.since)}` : ''}`)),
      closeButton(s, t, ctx),
    );
    terminals.append(row);
  }

  view.append(el('div', { className: 'sections' }, where, approvals, terminals));
  return view;
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
    const header = oldHeader && oldHeader.dataset.shape === headerShape(members) ? oldHeader : renderHeader(members, ctx);
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

