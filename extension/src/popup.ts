/**
 * The panel: discover sessions, pair with the code `serve` printed, bind this chat to one,
 * and put the tools manifest in its composer. The pairing code is typed here and nowhere
 * else — anything typed into the chat page reaches the chat provider.
 *
 * It opens over a chat (the overlay's frame, `?tab=<the chat's tab>`) and acts on that
 * chat; or in a tab of its own, with no chat to act on.
 */
import { DEFAULT_SETTINGS, type ApprovalItem, type DiscoveredSession, type Links, type PopupRequest, type Settings, type TabInfo } from './messages.js';
import { PANEL_CLOSE } from './panel-overlay.js';
import { asideHead, reconcile, renderDetail, type ListContext } from './popup-list.js';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

async function ask<T>(request: PopupRequest): Promise<T> {
  const answer = (await chrome.runtime.sendMessage(request)) as { value?: T; error?: string };
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.value as T;
}

function fail(e: unknown): void {
  $('error').textContent = (e as Error).message;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

let tabId: number | undefined;
let tab: TabInfo | undefined;
let links: Links = { dev: null, sessions: {} };
/** What is open beside the projects, if anything: a project's details, or the settings. */
let aside: { kind: 'detail'; nodeId: string } | { kind: 'settings' } | undefined;
let sessionsNow: DiscoveredSession[] = [];
let autoSend = DEFAULT_SETTINGS.autoSend;

function dot(state: boolean | undefined): HTMLElement {
  return el('span', { className: `dot ${state === undefined ? '' : state ? 'on' : 'off'}` });
}

async function renderLinks(given?: Links): Promise<void> {
  links = given ?? (await ask<Links>({ type: 'links' }));
  const box = $('links');
  box.replaceChildren();
  if (links.dev) {
    box.append(el('div', {}, dot(links.dev.connected), `dev control relay :${links.dev.port} — ${links.dev.connected ? 'connected' : 'not connected (is npm run ext:watch running?)'}`));
  }
}

/** The calls waiting for a yes in this browser: each opens its approval page. */
async function renderApprovals(given?: ApprovalItem[]): Promise<void> {
  const items = given ?? (await ask<ApprovalItem[]>({ type: 'approvals' }));
  const box = $('approvals');
  box.replaceChildren();
  if (items.length === 0) return;
  box.append(el('b', {}, items.length === 1 ? 'A call waits for your yes' : `${items.length} calls wait for your yes`));
  for (const item of items) {
    const review = el('button', { className: 'primary', textContent: 'Review' });
    review.onclick = () => void ask({ type: 'review', key: item.key }).catch(fail);
    box.append(el('div', { className: 'approval' }, el('span', { title: item.summary }, el('b', {}, item.project), ` · ${item.id} ${item.tool} — ${item.summary}`), review));
  }
}

async function renderTab(): Promise<void> {
  const box = $('tab');
  box.replaceChildren();
  box.className = tabId === undefined ? 'muted' : '';
  if (tabId === undefined) {
    box.append(el('div', { className: 'muted' }, 'Open this panel from a chat (the bushwhack icon, on the chat) to bind that chat to a project.'));
    return;
  }
  tab = await ask<TabInfo>({ type: 'tab', tabId });
  if (!tab.driver) {
    box.append(el('div', { className: 'muted' }, 'This tab is not a chat bushwhack knows.'));
    return;
  }
  const where = tab.conversation ? 'this conversation' : 'this new chat';
  if (!tab.bound) {
    box.append(el('div', {}, `${tab.driver}: ${where} is not bound to a session. Pick one below.`));
    return;
  }
  const manifest = el('button', { className: 'primary', textContent: 'Insert the tools manifest' });
  manifest.onclick = () => ask({ type: 'manifest', tabId: tabId! }).then(closePanel, fail);
  const unbind = el('button', { textContent: 'Unbind' });
  unbind.onclick = () => ask({ type: 'unbind', tabId: tabId! }).then(refresh, fail);
  box.append(el('div', {}, `${tab.driver}: ${where} works on `, el('b', {}, tab.bound.session), '.'), el('div', { className: 'row' }, manifest, unbind));
}

/** What the list needs from the popup: its state now, and what its buttons do. */
function context(): ListContext {
  return {
    links,
    tab,
    tabId,
    pair: (s, code) => void ask({ type: 'pair', port: s.port, nodeId: s.nodeId, code }).then(refresh, fail),
    bind: (s) => void ask({ type: 'bind', tabId: tabId!, nodeId: s.nodeId }).then(refresh, fail),
    forget: (s) => void ask({ type: 'forget', nodeId: s.nodeId }).then(refresh, fail),
    focus: (id) => void ask({ type: 'focus', tabId: id }).catch(fail),
    // A tab of its own; it joins the project's group once it shows the app.
    open: (url) => void chrome.tabs.create({ url }),
    details: (s) => openAside({ kind: 'detail', nodeId: s.nodeId }),
    closeTerminal: (s, terminal) => void ask({ type: 'close-terminal', nodeId: s.nodeId, terminal }).then(refresh, fail),
  };
}

function openAside(next: typeof aside): void {
  aside = next;
  renderAside();
  $('views').classList.toggle('aside', aside !== undefined);
  $('settings').classList.toggle('on', aside?.kind === 'settings');
  window.scrollTo({ top: 0 });
}

const closeAside = (): void => openAside(undefined);

/** The settings, beside the projects. */
function renderSettings(): HTMLElement {
  const box = el('input', { type: 'checkbox', checked: autoSend }) as HTMLInputElement;
  box.onchange = () => {
    autoSend = box.checked;
    void ask({ type: 'settings', autoSend: box.checked }).catch(fail);
  };
  const view = el('div', { className: 'settings' }, asideHead('Settings', `bushwhack v${chrome.runtime.getManifest().version}`, closeAside));
  view.append(
    el(
      'div',
      { className: 'sections' },
      el(
        'section',
        { className: 'section' },
        el('h4', {}, 'Results'),
        el('label', { className: 'line' }, box, ' Send results automatically'),
        el('div', { className: 'line muted' }, 'Off: the results wait in the message box, for you to send them.'),
      ),
    ),
  );
  return view;
}

/** What is open beside the projects — rebuilt only when what it shows changed (an open confirmation stays). */
function renderAside(): void {
  const box = $('aside');
  if (!aside) return;
  if (aside.kind === 'settings') {
    if (!box.querySelector('.settings')) box.replaceChildren(renderSettings());
    return;
  }
  const nodeId = aside.nodeId;
  const shown = sessionsNow.find((s) => s.nodeId === nodeId);
  if (!shown) return closeAside();
  const next = renderDetail(shown, context(), closeAside);
  if ((box.firstElementChild as HTMLElement | null)?.dataset.shape !== next.dataset.shape) box.replaceChildren(next);
}

/** The projects, and what is open beside them. */
function renderProjects(sessions: DiscoveredSession[]): void {
  sessionsNow = sessions;
  reconcile($('sessions'), sessions, context());
  renderAside();
}

async function refresh(): Promise<void> {
  $('error').textContent = '';
  await renderLinks();
  await renderApprovals();
  await renderTab();
  renderProjects(await ask<DiscoveredSession[]>({ type: 'discover' }));
}

/** Over a chat, give the chat back; in a tab of its own, there is nothing to close. */
function closePanel(): void {
  if (window.parent !== window) window.parent.postMessage(PANEL_CLOSE, '*');
}

async function main(): Promise<void> {
  // Opened by a copy of the extension that is gone (it was reloaded or updated under the
  // chat page): no extension API here. Say what fixes it rather than fail on the first call.
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
    $('error').textContent = 'The extension was updated under this page: reload the page, then open the panel again.';
    return;
  }
  // Which build this is, beside the name: what to say in a bug report, and whether a reload took.
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  const chat = Number(new URLSearchParams(location.search).get('tab'));
  tabId = Number.isInteger(chat) && chat > 0 ? chat : undefined;
  window.addEventListener('keydown', (e) => {
    // Escape goes back to the projects first, then closes the panel.
    if (e.key === 'Escape') {
      if (aside) closeAside();
      else closePanel();
    }
  });
  const stored = ((await chrome.storage.local.get('settings')).settings as Settings | undefined) ?? DEFAULT_SETTINGS;
  autoSend = stored.autoSend;
  $('settings').onclick = () => (aside?.kind === 'settings' ? closeAside() : openAside({ kind: 'settings' }));
  await refresh();
  // Live while the popup is open: the worker pushes its state when it changes — nothing is
  // asked on a timer. Cards update in place; one is rebuilt only when what it shows changed.
  chrome.runtime.onMessage.addListener((message: { type?: string; links?: Links; sessions?: DiscoveredSession[]; approvals?: ApprovalItem[] }) => {
    if (message?.type !== 'popup-state' || !message.links || !message.sessions) return;
    if (message.approvals) void renderApprovals(message.approvals);
    void renderLinks(message.links).then(() => renderProjects(message.sessions!));
  });
  // A project started elsewhere (bushwhack add, serve) is seen when the popup is looked at again.
  window.addEventListener('focus', () => void refresh().catch(fail));
}

main().catch(fail);
