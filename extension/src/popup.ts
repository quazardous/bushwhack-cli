/**
 * The panel: discover sessions, pair with the code `serve` printed, bind this chat to one,
 * and put the tools manifest in its composer. The pairing code is typed here and nowhere
 * else — anything typed into the chat page reaches the chat provider.
 *
 * It opens over a chat (the overlay's frame, `?tab=<the chat's tab>`) and acts on that
 * chat; or in a tab of its own, with no chat to act on.
 */
import type { DiscoveredSession, Links, PopupRequest, Settings, TabInfo } from './messages.js';
import { PANEL_CLOSE } from './panel-overlay.js';
import { reconcile, type ListContext } from './popup-list.js';

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
  };
}

async function refresh(): Promise<void> {
  $('error').textContent = '';
  await renderLinks();
  await renderTab();
  reconcile($('sessions'), await ask<DiscoveredSession[]>({ type: 'discover' }), context());
}

/** Over a chat, give the chat back; in a tab of its own, there is nothing to close. */
function closePanel(): void {
  if (window.parent !== window) window.parent.postMessage(PANEL_CLOSE, '*');
}

async function main(): Promise<void> {
  const chat = Number(new URLSearchParams(location.search).get('tab'));
  tabId = Number.isInteger(chat) && chat > 0 ? chat : undefined;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });
  const stored = ((await chrome.storage.local.get('settings')).settings as Settings | undefined) ?? { autoSend: false };
  const box = $('autosend') as HTMLInputElement;
  box.checked = stored.autoSend;
  box.onchange = () => void ask({ type: 'settings', autoSend: box.checked }).catch(fail);
  await refresh();
  // Live while the popup is open: the worker pushes its state when it changes — nothing is
  // asked on a timer. Cards update in place; one is rebuilt only when what it shows changed.
  chrome.runtime.onMessage.addListener((message: { type?: string; links?: Links; sessions?: DiscoveredSession[] }) => {
    if (message?.type !== 'popup-state' || !message.links || !message.sessions) return;
    void renderLinks(message.links).then(() => reconcile($('sessions'), message.sessions!, context()));
  });
  // A project started elsewhere (bushwhack add, serve) is seen when the popup is looked at again.
  window.addEventListener('focus', () => void refresh().catch(fail));
}

main().catch(fail);
