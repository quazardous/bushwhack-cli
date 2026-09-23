/**
 * The service worker: the extension's hub node, one relay connection per paired session.
 *
 * It does the network, not the content script: from an `https://` chat page, reaching
 * `http://127.0.0.1` runs into mixed-content rules and Private Network Access; from here,
 * with host permissions, it does not — and the pairing codes never enter the page.
 *
 * It also owns the page↔project binding. The model can name neither a session nor a
 * port: a call from a conversation goes to the session that conversation was bound to in
 * the popup, and nowhere else.
 */
import { chatPrompt, DRIVERS, selectDriver, type DriverSpec } from '@bushwhack/chat-drivers';
import { HubNode, WebSocketTransport } from '@bushwhack/hub';
import { PAGE_ACT, PAGE_REPLY, PageController } from '@bushwhack/page';
import { chromeBrowser, isPageRequest, sessionTabs } from './page-browser.js';
import { appOwner, joinSessionGroup, leaveSessionGroup, watchTabGroups } from './tab-groups.js';
import { accept } from './accept.js';
import { nextCallId } from './call-ids.js';
import { ConversationOwners } from './conversation-owners.js';
import {
  BRIDGE,
  CHAT,
  type ChatSendRequest,
  EXTENSION_NODE_PREFIX,
  EXTENSION_RELOAD,
  normalizePairingCode,
  rangePorts,
  type SessionHealth,
  type ToolsCallReply,
  type ToolsListReply,
} from '@bushwhack/protocol';
import {
  DEV_CALL,
  type CallsResponse,
  type PictureResponse,
  type ContentRequest,
  type DevCommand,
  type DiscoveredSession,
  type Links,
  type PopupRequest,
  type Settings,
  type StatusResponse,
  type TabCommand,
  type TabInfo,
  type WhoAmI,
} from './messages.js';

/** Set by the build: true in `ext:watch` builds, false (and the dev code dropped) otherwise. */
declare const __DEV__: boolean;

interface Pairing {
  nodeId: string;
  session: string;
  folder: string;
  port: number;
  code: string;
  /** The bushwhack service it belongs to: one pairing code for all its projects. */
  service?: string;
}

/** A call waits for the operator's approval in a terminal; that can take a while. */
const CALL_TIMEOUT_MS = 15 * 60 * 1000;

// ─── Storage ──────────────────────────────────────────────────────────────────

async function load<T>(key: string, fallback: T): Promise<T> {
  const got = await chrome.storage.local.get(key);
  return (got[key] as T | undefined) ?? fallback;
}

async function save(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

const pairings = (): Promise<Record<string, Pairing>> => load('pairings', {});
/** Services paired once for all their projects, by service id. */
const services = (): Promise<Record<string, { code: string }>> => load('services', {});
const bindings = (): Promise<Record<string, string>> => load('bindings', {});
/** Which project's tools manifest each conversation has been given, by conversation. */
const manifested = (): Promise<Record<string, string>> => load('manifested', {});

async function markManifested(conversation: string, session: string): Promise<void> {
  const all = await manifested();
  if (all[conversation] === session) return;
  await save('manifested', { ...all, [conversation]: session });
}

/**
 * The tools manifest of a project, made for the chat it goes into. Into a conversation
 * that already has calls, it says which ids are taken: a model given the manifest again
 * starts over at c1, and a call repeating an old one word for word is taken as that one,
 * already answered.
 */
async function manifestFor(session: string, driver: DriverSpec, conversation?: string | null): Promise<string> {
  const { node } = await connection(session);
  const reply = await node.request(BRIDGE.list, { chat: chatPrompt(driver) }, { target: session, timeoutMs: 5000 });
  const manifest = unwrap<ToolsListReply>(reply.payload).manifest;
  const next = conversation ? await nextCallIdOf(conversation) : 1;
  return next > 1 ? `${manifest}\n\nIn this conversation, call ids up to c${next - 1} are already taken: go on from c${next}.` : manifest;
}

/** The first `c<n>` id no call of this conversation has used. */
async function nextCallIdOf(conversation: string): Promise<number> {
  const key = `handled:${conversation}`;
  return nextCallId(((await chrome.storage.local.get(key))[key] as string[] | undefined) ?? []);
}
const settings = (): Promise<Settings> => load('settings', { autoSend: false });

/** Who we are on a relay: which extension, which build — visible in the relay's /clients. */
function identity(): Record<string, string> {
  const manifest = chrome.runtime.getManifest();
  return {
    client: __DEV__ ? 'extension-dev' : 'extension',
    extensionId: chrome.runtime.id,
    extensionVersion: manifest.version,
    botName: manifest.name,
    // Which browser this is, for `bushwhack` to say where prompts go: "Chromium 153", "Google Chrome 140".
    fingerprint: browserName(),
  };
}

function browserName(): string {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } }).userAgentData?.brands ?? [];
  const named = brands.find((b) => !/not.?a.?brand/i.test(b.brand) && b.brand !== 'Chromium') ?? brands.find((b) => b.brand === 'Chromium');
  return named ? `${named.brand} ${named.version}` : 'a Chromium browser';
}

// ─── Log ──────────────────────────────────────────────────────────────────────
//
// The worker has no console anyone reads. It keeps its last lines in storage (the dev
// channel's `state` returns them) and, in dev builds, also sends them to the control
// relay, which files them under .dev-logs/extension.log.

const LOG_LINES = 200;
let logQueue: Promise<void> = Promise.resolve();
let devNode: HubNode | undefined;

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  logQueue = logQueue.then(async () => {
    const lines = await load<string[]>('log', []);
    lines.push(line);
    await save('log', lines.slice(-LOG_LINES));
  }).catch(() => undefined);
  if (devNode) {
    devNode.emit('@log', { channel: 'extension', level: 'info', source: chrome.runtime.id, message, timestamp: Date.now() }, { target: 'relay' });
  }
}

let nodeIdPromise: Promise<string> | undefined;

/** Created once and kept; concurrent first callers share one promise, so one id. */
function myNodeId(): Promise<string> {
  nodeIdPromise ??= (async () => {
    let id = await load<string | null>('nodeId', null);
    if (!id) {
      id = `${EXTENSION_NODE_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
      await save('nodeId', id);
    }
    return id;
  })();
  return nodeIdPromise;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

interface RelayHealth {
  /** The service's id, when the relay is the service's (every project on it). */
  service?: string;
  /** The service's instance name (`default`, `dev`…). */
  instance?: string;
  sessions: { session: string; folder: string; nodeId: string; url?: unknown }[];
}

/** Who is on a relay: one session (`serve`), or a service's every project. */
async function health(port: number): Promise<RelayHealth | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) });
    const body = (await response.json()) as Partial<SessionHealth> & { daemon?: unknown; instance?: unknown };
    if (body.service !== 'bushwhack') return undefined;
    const valid = (s: { session?: unknown; folder?: unknown; nodeId?: unknown }): s is { session: string; folder: string; nodeId: string } =>
      typeof s.session === 'string' && typeof s.folder === 'string' && typeof s.nodeId === 'string';
    if (typeof body.daemon === 'string' && Array.isArray(body.sessions)) {
      return { service: body.daemon, ...(typeof body.instance === 'string' ? { instance: body.instance } : {}), sessions: body.sessions.filter(valid) };
    }
    return valid(body) ? { sessions: [{ session: body.session, folder: body.folder, nodeId: body.nodeId }] } : undefined;
  } catch {
    return undefined;
  }
}

/** A project's app address from /health — only one on the project's own `.localhost` name is kept. */
function appUrlOf(s: { session: string; url?: unknown }): string | undefined {
  return typeof s.url === 'string' && appOwner(s.url, [s]) ? s.url : undefined;
}

async function discover(): Promise<DiscoveredSession[]> {
  const [known, paired] = await Promise.all([pairings(), services()]);
  const found = await Promise.all(rangePorts().map(async (port) => ({ port, h: await health(port) })));
  return found.flatMap(({ port, h }) =>
    (h?.sessions ?? []).map(({ url, ...s }) => ({ port, ...s, ...(appUrlOf({ session: s.session, url }) ? { url: appUrlOf({ session: s.session, url })! } : {}), ...(h?.service ? { service: h.service } : {}), ...(h?.instance ? { instance: h.instance } : {}), paired: s.nodeId in known || (h?.service !== undefined && h.service in paired), chats: [] })),
  );
}

/** Which open chat tab shows which conversation (or, before its first message, which tab binding). */
async function openChats(): Promise<Map<string, { tabId: number; title?: string }>> {
  const hosts = DRIVERS.flatMap((d) => d.hosts);
  const open = new Map<string, { tabId: number; title?: string }>();
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id === undefined) continue;
    let host = '';
    try {
      host = new URL(tab.url ?? '').hostname;
    } catch {
      continue;
    }
    if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    const who = await askTab<WhoAmI>(tab.id, { type: 'whoami' });
    open.set(who?.conversation ?? tabKey(tab.id), { tabId: tab.id, title: tab.title });
  }
  return open;
}

/** Sessions on this machine, each with the conversations bound to it. */
async function sessionsWithChats(): Promise<DiscoveredSession[]> {
  const [sessions, bound, open] = await Promise.all([discover(), bindings(), openChats()]);
  for (const session of sessions) {
    session.chats = Object.entries(bound)
      .filter(([, nodeId]) => nodeId === session.nodeId)
      .map(([conversation]) => ({ conversation, ...open.get(conversation) }));
  }
  return sessions;
}

/** Where a paired session is now: its last port, or wherever it moved to after a restart. */
async function locate(pairing: Pairing): Promise<number | undefined> {
  if ((await health(pairing.port))?.sessions.some((s) => s.nodeId === pairing.nodeId)) return pairing.port;
  const moved = (await discover()).find((s) => s.nodeId === pairing.nodeId);
  if (!moved) return undefined;
  await save('pairings', { ...(await pairings()), [pairing.nodeId]: { ...pairing, port: moved.port } });
  return moved.port;
}

/**
 * A session's pairing: its own, or — for a project added to a paired service since — made
 * from the service's code, the one pairing the operator gave for all of its projects.
 */
async function pairingFor(nodeId: string): Promise<Pairing | undefined> {
  const own = (await pairings())[nodeId];
  if (own) return own;
  const paired = await services();
  for (const port of rangePorts()) {
    const h = await health(port);
    const s = h?.sessions.find((x) => x.nodeId === nodeId);
    if (!h?.service || !s || !(h.service in paired)) continue;
    const made: Pairing = { ...s, port, code: paired[h.service].code, service: h.service };
    await save('pairings', { ...(await pairings()), [nodeId]: made });
    return made;
  }
  return undefined;
}

// ─── Connections ──────────────────────────────────────────────────────────────

interface Connection {
  node: HubNode;
  transport: WebSocketTransport;
}

/** One connection per relay — a service's relay carries all its projects. */
const connections = new Map<number, Connection>();
const pages = new PageController(chromeBrowser, sessionTabs);

async function open(port: number, code: string, label: string): Promise<Connection> {
  log(`${label}: connecting on port ${port}`);
  const nodeId = await myNodeId();
  const node = new HubNode({ nodeId, defaultScope: 'global' });
  const transport = new WebSocketTransport({
    name: `relay:${port}`,
    url: `ws://127.0.0.1:${port}`,
    peerPatterns: ['*'],
    keepAliveMs: 20_000,
    reconnect: { maxAttempts: 3 },
    registrationMessage: { type: 'register', nodeId, securityKey: code, ...identity() },
  });
  node.addTransport(transport);
  node.on(EXTENSION_RELOAD, () => chrome.runtime.reload());
  // A prompt from the operator's terminal. Only the service sends one — it checked the
  // operator's key, and the relay lets nobody else hold its name.
  node.on(CHAT.send, (payload: unknown, envelope) => {
    if (envelope.source !== SERVICE_NODE) return;
    void chatSend(payload as ChatSendRequest).then((answer) => node.emit(CHAT.reply, answer, { target: envelope.source, replyToId: envelope.id }));
  });
  // page:* calls come back from a session: only from a session paired on this relay, and
  // only about its own app, whose origins its daemon decided.
  node.on(PAGE_ACT, (payload: unknown, envelope) => {
    const answer = (outcome: unknown): void => {
      node.emit(PAGE_REPLY, outcome, { target: envelope.source, replyToId: envelope.id });
    };
    void pairingFor(envelope.source).then((pairing) => {
      if (!pairing || pairing.port !== port) return;
      if (!isPageRequest(payload, pairing.nodeId)) {
        answer({ error: 'the extension refused a malformed page request' });
        return;
      }
      log(`session ${pairing.session}: page:${payload.action}`);
      pages.run(payload).then(answer, (e: unknown) => answer({ status: 'error', content: `the browser failed: ${(e as Error).message}` }));
    });
  });
  transport.onStateChange((state) => {
    log(`${label}: ${JSON.stringify(state)}`);
    stateChanged();
  });
  await transport.connect();
  return { node, transport };
}

/** Connections being opened, by port: callers at the same moment share one. */
const opening = new Map<number, Promise<Connection>>();

/**
 * The connection to a relay, opened when there is none (or it dropped). Two opened at once
 * would register the same name: the relay keeps the newer, and the older is gone.
 */
async function relay(port: number, code: string, label: string): Promise<Connection> {
  const existing = connections.get(port);
  if (existing?.transport.state.connected) return existing;
  const pending = opening.get(port);
  if (pending) return pending;
  const attempt = (async () => {
    existing?.transport.disconnect();
    connections.delete(port);
    const fresh = await open(port, code, label);
    connections.set(port, fresh);
    return fresh;
  })().finally(() => opening.delete(port));
  opening.set(port, attempt);
  return attempt;
}

async function connection(sessionNodeId: string): Promise<Connection> {
  const pairing = await pairingFor(sessionNodeId);
  if (!pairing) throw new Error('this session is not paired');
  const port = await locate(pairing);
  if (port === undefined) throw new Error(`session "${pairing.session}" is not running (bushwhack list, or bushwhack serve in ${pairing.folder})`);
  return relay(port, pairing.code, pairing.service ? `service (${pairing.session})` : `session ${pairing.session}`);
}

/** When this browser last told a service it holds a project's chat, by session. */
const announced = new Map<string, number>();

/**
 * Tell the project's service this browser has its chat open, and which chat it is (Meta AI,
 * Gemini…): prompts from a terminal come here. `now` skips the pacing — a chat just bound.
 */
function announce(conn: Connection, nodeId: string, conversation: string | null, chat: string | undefined, now = false): void {
  if (!now && Date.now() - (announced.get(nodeId) ?? 0) < 5_000) return;
  announced.set(nodeId, Date.now());
  conn.node.emit(CHAT.here, { session: nodeId, conversation, ...(chat ? { chat } : {}) }, { target: SERVICE_NODE });
}

/** Tell the project's service this browser no longer shows its chat — navigated away, or closed. */
function leave(conn: Connection, nodeId: string): void {
  announced.delete(nodeId);
  conn.node.emit(CHAT.here, { session: nodeId, left: true }, { target: SERVICE_NODE });
}

/** The chat a tab shows, by its driver: "Meta AI", "Gemini"… */
async function chatOfTab(tabId: number | undefined): Promise<DriverSpec | undefined> {
  if (tabId === undefined) return undefined;
  try {
    return selectDriver(DRIVERS, new URL((await chrome.tabs.get(tabId)).url ?? '').hostname);
  } catch {
    return undefined;
  }
}

/** The service's node on its relay: the only sender of terminal prompts. */
const SERVICE_NODE = 'service:bushwhack';

/**
 * Write a terminal's prompt in the project's chat and send it: the open tab of a
 * conversation bound to that project. meta.ai only mounts its message box in a visible
 * tab, so the tab is brought to the front.
 */
async function chatSend(request: ChatSendRequest): Promise<{ ok: true; conversation: string } | { error: string }> {
  if (typeof request?.session !== 'string' || typeof request.text !== 'string' || (request.manifest !== true && request.text.trim() === '')) return { error: 'nothing to send' };
  const bound = Object.entries(await bindings()).filter(([, nodeId]) => nodeId === request.session).map(([conversation]) => conversation);
  const open = await openChats();
  // A conversation open in several tabs: the one acting for it.
  const tabOf = (conversation: string) => {
    const owner = owners.owner(conversation);
    return owner !== undefined ? { tabId: owner } : open.get(conversation);
  };
  const target = bound.map((conversation) => ({ conversation, tab: tabOf(conversation) })).find((c) => c.tab);
  if (!target?.tab) return { error: 'no chat bound to this project is open — open one, and bind it in the popup' };
  const tab = await chrome.tabs.get(target.tab.tabId);
  if (tab.windowId !== undefined) {
    await chrome.tabs.update(target.tab.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  }
  // The manifest when asked for — and ahead of the first prompt a conversation gets from the
  // terminal, if it has never had this project's: the model cannot use tools it was not told of.
  const first = (await manifested())[target.conversation] !== request.session;
  let text = request.text;
  if (request.manifest === true || first) {
    // From the tab, not the binding: a fresh chat is bound by tab until its first message.
    const driver = await chatOfTab(target.tab.tabId);
    if (!driver) return { error: 'no driver for this chat' };
    const manifest = await manifestFor(request.session, driver, target.conversation.startsWith('tab:') ? null : target.conversation);
    text = request.manifest === true ? manifest : `${manifest}\n\n---\n\n${request.text}`;
  }
  const outcome = await askTab<string>(target.tab.tabId, { type: 'prompt', text });
  if (outcome === 'sent' && text !== request.text) await markManifested(target.conversation, request.session);
  const said: Record<string, string> = {
    busy: 'you are typing in that chat — the prompt was not written',
    'not-empty': 'the chat\'s message box is not empty — empty it, and send again',
    'no-composer': 'the chat is still loading its message box — try again in a moment',
    'not-sent': 'written in the chat, but its send button did not respond',
  };
  return outcome === 'sent' ? { ok: true, conversation: target.conversation } : { error: said[outcome ?? ''] ?? 'the chat did not answer' };
}

/** A chat's events, to the terminals following its project — through the service, when it is one. */
async function forwardChatEvent(request: Extract<ContentRequest, { type: 'chat-event' }>, tabId: number | undefined): Promise<void> {
  const nodeId = await sessionFor(request.conversation, tabId);
  if (!nodeId) return;
  const pairing = (await pairings())[nodeId];
  if (!pairing?.service) return;
  const conn = connections.get(pairing.port);
  if (!conn?.transport.state.connected) return;
  conn.node.emit(CHAT.event, { ...request.event, session: nodeId, ...(request.conversation ? { conversation: request.conversation } : {}) }, { target: SERVICE_NODE });
}

function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'error' in payload) throw new Error(String((payload as { error: unknown }).error));
  return payload as T;
}

// ─── Bindings ─────────────────────────────────────────────────────────────────

const tabKey = (tabId: number): string => `tab:${tabId}`;

async function askTab<T>(tabId: number, command: TabCommand): Promise<T | undefined> {
  try {
    return (await chrome.tabs.sendMessage(tabId, command)) as T;
  } catch {
    // No content script there: the page predates the extension (or its last reload).
    // Give it one and ask again, once.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return (await chrome.tabs.sendMessage(tabId, command)) as T;
    } catch {
      return undefined;
    }
  }
}

/**
 * The session for a conversation. A fresh chat has no conversation id until its first
 * message, so it is bound by tab until then. The page's status says how it came to show a
 * conversation (`arrival`): one born in the tab takes the binding over, where it survives
 * the tab; one navigated to ends the tab's binding — the fresh chat was left, and an old
 * conversation must not become the project's, its old calls taken for new. Without an
 * arrival (any other request), nothing moves.
 */
async function sessionFor(conversation: string | null, tabId: number | undefined, arrival?: 'born' | 'navigated'): Promise<string | undefined> {
  const all = await bindings();
  const byTab = tabId === undefined ? undefined : all[tabKey(tabId)];
  if (conversation && byTab && arrival) {
    delete all[tabKey(tabId!)];
    if (arrival === 'born' && !all[conversation]) all[conversation] = byTab;
    await save('bindings', all);
  }
  if (conversation) return all[conversation];
  return byTab;
}

/** The project each chat tab showed at its last status: what it left when that changes. */
const tabShows = new Map<number, string>();
/** Which tab acts for a conversation open in several. */
const owners = new ConversationOwners();
chrome.tabs.onActivated.addListener(({ tabId }) => owners.activated(tabId));

/**
 * Chrome slows a hidden tab's timers to about one a minute: the page's own loop would read
 * the chat, send results and say it is there that seldom — a chat in a window behind others
 * crawled. The worker's timers are not slowed: it wakes the bound chat tabs itself.
 */
setInterval(() => {
  for (const tabId of tabShows.keys()) chrome.tabs.sendMessage(tabId, { type: 'tick' } satisfies TabCommand).catch(() => undefined);
}, 2000);
/** Another tab still shows this project's chat: leaving one tab does not leave the chat. */
const shownElsewhere = (nodeId: string): boolean => [...tabShows.values()].includes(nodeId);

/**
 * A chat tab shows another project's chat, or none any more: its group follows, and the
 * services hear it at once — the one left drops it, the one joined says where prompts go.
 */
async function followTab(tabId: number, nodeId: string | undefined, conversation: string | null): Promise<void> {
  const before = tabShows.get(tabId);
  if (before === nodeId) return;
  if (nodeId) tabShows.set(tabId, nodeId);
  else tabShows.delete(tabId);
  if (before && !shownElsewhere(before)) void connection(before).then((conn) => leave(conn, before), () => undefined);
  if (nodeId) {
    await groupChat(tabId, nodeId);
    const chat = (await chatOfTab(tabId))?.title;
    void connection(nodeId).then((conn) => announce(conn, nodeId, conversation, chat, true), () => undefined);
  } else {
    await leaveSessionGroup(tabId).catch(() => undefined);
  }
}

async function tabInfo(tabId: number): Promise<TabInfo> {
  const who = await askTab<WhoAmI>(tabId, { type: 'whoami' });
  const nodeId = await sessionFor(who?.conversation ?? null, tabId);
  const pairing = nodeId ? (await pairings())[nodeId] : undefined;
  return {
    driver: who?.driver ?? null,
    conversation: who?.conversation ?? null,
    bound: nodeId ? { nodeId, session: pairing?.session ?? nodeId } : null,
  };
}

/** A bound chat joins its project's tab group, next to the app's tab. Never fails a request. */
async function groupChat(tabId: number, nodeId: string): Promise<void> {
  const pairing = (await pairings())[nodeId];
  if (pairing) await joinSessionGroup(tabId, nodeId, pairing.session).catch(() => undefined);
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function onContent(request: ContentRequest, tabId: number | undefined): Promise<CallsResponse | StatusResponse | PictureResponse | null> {
  switch (request.type) {
    case 'chat-event':
      await forwardChatEvent(request, tabId);
      return null;
    case 'status': {
      const nodeId = await sessionFor(request.conversation, tabId, request.conversation ? (request.born ? 'born' : 'navigated') : undefined);
      if (tabId !== undefined) await followTab(tabId, nodeId, request.conversation);
      // While a bound chat is open, stay connected to its project: the terminal may speak
      // first (a prompt typed in bushwhack), and nobody would be listening otherwise.
      if (nodeId) {
        const chat = (await chatOfTab(tabId))?.title;
        void connection(nodeId).then((conn) => announce(conn, nodeId, request.conversation, chat), () => undefined);
      }
      const pairing = nodeId ? (await pairings())[nodeId] : undefined;
      const acts = tabId === undefined || owners.report(tabId, request.conversation);
      return { bound: pairing?.session ?? null, autoSend: (await settings()).autoSend, ...(acts ? {} : { elsewhere: true }) };
    }
    case 'picture':
      return fetchPicture(request.url);
    case 'calls': {
      const nodeId = await sessionFor(request.conversation, tabId);
      if (!nodeId) return { error: 'not bound' };
      if (tabId !== undefined) await groupChat(tabId, nodeId);
      try {
        const { node, transport } = await connection(nodeId);
        const reply = await Promise.race([
          node.request(BRIDGE.call, { conversation: request.conversation, calls: request.calls, ...(request.pictures?.length ? { pictures: request.pictures } : {}) }, { target: nodeId, timeoutMs: CALL_TIMEOUT_MS }),
          // A call waits as long as an approval may take. Were the service to go away
          // meanwhile (restarted), the page would wait on it all the same, handling
          // nothing else: the model hears at once instead.
          new Promise<never>((_, fail) => {
            transport.onStateChange((state) => {
              if (!state.connected) fail(new Error('the bushwhack service went away while this call was running — it may have run; look, then try again with a new id'));
            });
          }),
        ]);
        return unwrap<ToolsCallReply>(reply.payload);
      } catch (e) {
        return { error: (e as Error).message };
      }
    }
  }
}

/** The most a picture may weigh, fetched for image:save. */
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

/**
 * A generated picture the chat's page may not read (its CDN sends no CORS header), fetched
 * here with the extension's host permission — from a driver's declared image hosts only,
 * so a page cannot make the extension fetch anything else.
 */
async function fetchPicture(url: string): Promise<PictureResponse> {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return { error: 'not an https picture' };
    host = parsed.hostname;
  } catch {
    return { error: 'not a URL' };
  }
  const allowed = DRIVERS.flatMap((d) => d.imageHosts ?? []);
  if (!allowed.some((h) => host === h || host.endsWith(`.${h}`))) return { error: 'not a chat\'s picture host' };
  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const type = response.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return { error: 'not a picture' };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_PICTURE_BYTES) return { error: 'too big' };
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { dataUrl: `data:${type.split(';')[0]};base64,${btoa(binary)}` };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function linksNow(): Promise<Links> {
  return {
    dev: __DEV_CONTROL__ ? { port: __DEV_CONTROL__.port, connected: devTransport?.state.connected ?? false } : null,
    sessions: Object.fromEntries(Object.values(await pairings()).map((p) => [p.nodeId, connections.get(p.port)?.transport.state.connected ?? false])),
  };
}

/**
 * The popup's state, pushed when it changes instead of asked for every few seconds. A
 * burst of changes (a pairing connects, then its tabs report) sends one push. Nothing
 * listens when the popup is closed; the send simply finds nobody.
 */
let stateTimer: ReturnType<typeof setTimeout> | undefined;
function stateChanged(): void {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    void Promise.all([linksNow(), sessionsWithChats()])
      .then(([links, sessions]) => chrome.runtime.sendMessage({ type: 'popup-state', links, sessions }))
      .catch(() => undefined);
  }, 150);
}

async function onPopup(request: PopupRequest): Promise<unknown> {
  // Development: where the panel is seen working — over a chat, it is out of reach otherwise.
  if (__DEV__ && request.type === 'tab') log(`panel: over the chat of tab ${request.tabId}`);
  // Whatever the popup asked may change what it shows: it gets the new state pushed.
  try {
    return await onPopupRequest(request);
  } finally {
    if (!['discover', 'links', 'tab'].includes(request.type)) stateChanged();
  }
}

async function onPopupRequest(request: PopupRequest): Promise<unknown> {
  switch (request.type) {
    case 'discover':
      return sessionsWithChats();
    case 'focus': {
      const tab = await chrome.tabs.update(request.tabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true };
    }
    case 'pair': {
      const h = await health(request.port);
      const target = h?.sessions.find((x) => x.nodeId === request.nodeId);
      if (!h || !target) throw new Error('that session is no longer on this port; discover again');
      const code = normalizePairingCode(request.code);
      connections.get(request.port)?.transport.disconnect();
      connections.delete(request.port);
      const conn = await open(request.port, code, h.service ? 'service' : `session ${target.session}`).catch(() => {
        throw new Error(h.service ? 'the service refused this code — bushwhack list shows it' : 'the session refused this code — check it in the serve terminal');
      });
      connections.set(request.port, conn);
      const all = await pairings();
      if (h.service) {
        // One code for the service: every project on it is paired, and so is any added later.
        await save('services', { ...(await services()), [h.service]: { code } });
        for (const s of h.sessions) all[s.nodeId] = { ...s, port: request.port, code, service: h.service };
      } else {
        all[target.nodeId] = { ...target, port: request.port, code };
      }
      await save('pairings', all);
      return { ok: true };
    }
    case 'forget': {
      const all = await pairings();
      const forgotten = all[request.nodeId];
      // A service is paired as a whole: forgetting one of its projects forgets the service.
      const gone = forgotten?.service ? Object.values(all).filter((p) => p.service === forgotten.service).map((p) => p.nodeId) : [request.nodeId];
      if (forgotten?.service) {
        const paired = await services();
        delete paired[forgotten.service];
        await save('services', paired);
      }
      for (const id of gone) delete all[id];
      await save('pairings', all);
      if (forgotten) {
        connections.get(forgotten.port)?.transport.disconnect();
        connections.delete(forgotten.port);
      }
      const bound = await bindings();
      for (const [key, nodeId] of Object.entries(bound)) if (gone.includes(nodeId)) delete bound[key];
      await save('bindings', bound);
      return { ok: true };
    }
    case 'tab':
      return tabInfo(request.tabId);
    case 'bind': {
      const who = await askTab<WhoAmI>(request.tabId, { type: 'whoami' });
      if (!who) throw new Error('no chat driver on this tab — reload the page');
      if (!(await pairingFor(request.nodeId))) throw new Error('pair the session first');
      // Past calls in this conversation are history, not requests: mark them handled
      // before the binding exists, so none of them runs.
      await askTab(request.tabId, { type: 'baseline' });
      const all = await bindings();
      all[who.conversation ?? tabKey(request.tabId)] = request.nodeId;
      await save('bindings', all);
      await groupChat(request.tabId, request.nodeId);
      // At once: a terminal following the project says which chat it now talks to.
      void connection(request.nodeId).then((conn) => announce(conn, request.nodeId, who.conversation, who.driver ?? undefined, true), () => undefined);
      return tabInfo(request.tabId);
    }
    case 'unbind': {
      const who = await askTab<WhoAmI>(request.tabId, { type: 'whoami' });
      const all = await bindings();
      delete all[tabKey(request.tabId)];
      if (who?.conversation) delete all[who.conversation];
      await save('bindings', all);
      return tabInfo(request.tabId);
    }
    case 'manifest': {
      const who = await askTab<WhoAmI>(request.tabId, { type: 'whoami' });
      const nodeId = await sessionFor(who?.conversation ?? null, request.tabId);
      if (!who || !nodeId) throw new Error('bind this chat to a session first');
      const driver = selectDriver(DRIVERS, who.host);
      if (!driver) throw new Error('no driver for this chat');
      const manifest = await manifestFor(nodeId, driver, who.conversation);
      const outcome = await askTab<'written' | 'not-empty' | 'no-composer'>(request.tabId, { type: 'write', text: manifest });
      if (outcome === 'not-empty') throw new Error('the message box is not empty — clear it and try again');
      if (outcome !== 'written') throw new Error('the chat is still loading its message box — try again in a moment');
      // Written, for the operator to send: the terminal will not add it to its first prompt.
      if (who.conversation) await markManifested(who.conversation, nodeId);
      return { ok: true };
    }
    case 'settings':
      await save('settings', { autoSend: request.autoSend } satisfies Settings);
      return { ok: true };
    case 'links':
      return linksNow();
  }
}

/**
 * Content scripts declared in the manifest only reach pages loaded after the extension.
 * After an install, an update or a reload, open chat tabs still run the old copy — now an
 * orphan — or none at all: give them the current one.
 */
async function injectIntoOpenChats(): Promise<void> {
  const hosts = DRIVERS.flatMap((d) => d.hosts);
  for (const tab of await chrome.tabs.query({})) {
    let host: string;
    try {
      host = new URL(tab.url ?? '').hostname;
    } catch {
      continue;
    }
    if (tab.id === undefined || !hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => undefined);
  }
}

watchTabGroups();
// Chat tabs opening, changing conversation or closing change what the popup lists.
/**
 * The icon: the panel over the chat shown — an overlay the content script draws, framing
 * the panel page — or, on any other page (or a chat page that does not answer yet), the
 * panel in a tab of its own.
 */
chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    let host = '';
    try {
      host = new URL(tab.url ?? '').hostname;
    } catch {
      // not a page
    }
    if (tab.id !== undefined && selectDriver(DRIVERS, host) && (await askTab<boolean>(tab.id, { type: 'panel', tabId: tab.id }))) return;
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
  })();
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url !== undefined || change.title !== undefined || change.status === 'complete') stateChanged();
  if (change.url !== undefined) void followAppTab(tabId, change.url);
});

/**
 * A tab on a project's app — opened by hand, not by page:open — joins the project's group;
 * one this module grouped that went elsewhere leaves it. Chat tabs follow their chat instead.
 */
async function followAppTab(tabId: number, url: string): Promise<void> {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (selectDriver(DRIVERS, host)) return;
  const owner = host.endsWith('.localhost') ? appOwner(url, (await discover()).filter((s) => s.paired)) : undefined;
  if (owner) await joinSessionGroup(tabId, owner.nodeId, owner.session).catch(() => undefined);
  else await leaveSessionGroup(tabId).catch(() => undefined);
}
chrome.tabs.onRemoved.addListener((tabId) => {
  stateChanged();
  const before = tabShows.get(tabId);
  tabShows.delete(tabId);
  owners.forget(tabId);
  if (before && !shownElsewhere(before)) void connection(before).then((conn) => leave(conn, before), () => undefined);
});
chrome.runtime.onInstalled.addListener(() => void injectIntoOpenChats());
chrome.runtime.onStartup.addListener(() => void injectIntoOpenChats());

chrome.runtime.onMessage.addListener((message: { from?: string } & (ContentRequest | PopupRequest), sender, respond) => {
  const who = accept(sender, { id: chrome.runtime.id, panelPaths: ['/popup.html', '/frame.html'], hosts: DRIVERS.flatMap((d) => d.hosts) });
  if (!who) {
    if (__DEV__) log(`refused a message from ${sender.url ?? '?'} (frame ${sender.frameId ?? '-'}, tab ${sender.tab?.id ?? '-'})`);
    return false;
  }
  const work = who === 'popup'
    ? onPopup(message as PopupRequest).then((value) => ({ value }), (e: Error) => ({ error: e.message }))
    : onContent(message as ContentRequest, sender.tab?.id).catch((e: Error) => {
        // Answered all the same: a page left waiting stops handling its calls for good.
        log(`${(message as ContentRequest).type} from tab ${sender.tab?.id ?? '-'} failed: ${e.message}`);
        return (message as ContentRequest).type === 'calls' ? { error: `the extension failed: ${e.message}` } : null;
      });
  void work.then(respond);
  return true;
});

// ─── Development control channel ─────────────────────────────────────────────
//
// Dev builds only. The build process hosts a relay and compiles its port and key into
// the bundle; the worker connects to it, so a terminal can see the extension's state
// and drive the popup's actions and a chat tab — which is how the extension is tested
// end to end without a browser automation tool, and how it is reloaded after a rebuild.

async function devHandle(command: DevCommand): Promise<unknown> {
  switch (command.action) {
    case 'state': {
      const driverHosts = DRIVERS.flatMap((d) => d.hosts);
      const tabs = (await chrome.tabs.query({})).filter((t) => {
        try {
          const host = new URL(t.url ?? '').hostname;
          return driverHosts.some((h) => host === h || host.endsWith(`.${h}`));
        } catch {
          return false;
        }
      });
      return {
        version: chrome.runtime.getManifest().version,
        nodeId: await myNodeId(),
        pairings: Object.values(await pairings()).map(({ code: _code, ...rest }) => rest),
        bindings: await bindings(),
        settings: await settings(),
        connections: Object.fromEntries([...connections].map(([id, c]) => [id, c.transport.state])),
        tabs: tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title, active: t.active, groupId: t.groupId, windowId: t.windowId })),
        groups: await Promise.all(
          (await chrome.tabGroups.query({})).map(async (g) => ({ groupId: g.id, title: g.title, color: g.color, tabs: (await chrome.tabs.query({ groupId: g.id })).map((t) => t.url) })),
        ),
        log: (await load<string[]>('log', [])).slice(-40),
      };
    }
    case 'popup':
      return onPopup(command.request);
    case 'open': {
      const tab = await chrome.tabs.create({ url: command.url, active: true });
      return { tabId: tab.id };
    }
    case 'reload-tab':
      await chrome.tabs.reload(command.tabId);
      return { ok: true };
    case 'tab':
      return chrome.tabs.sendMessage(command.tabId, command.command);
  }
}

/** Set by the build in dev builds: where the control relay is, and its key. Null otherwise. */
declare const __DEV_CONTROL__: { port: number; key: string } | null;

let devTransport: WebSocketTransport | undefined;

/**
 * Connect to the control relay unless already connected. Called when the worker starts,
 * on browser startup and install, and on every heartbeat alarm: a suspended worker loses
 * its socket, and the alarm is what wakes it to reconnect.
 */
let devConnecting: Promise<void> | undefined;

/** Startup, install and the first alarm all call this at once; they share one attempt. */
function ensureDevControl(): Promise<void> {
  devConnecting ??= connectDevControl().finally(() => {
    devConnecting = undefined;
  });
  return devConnecting;
}

async function connectDevControl(): Promise<void> {
  const config = __DEV_CONTROL__;
  // A transport that is reconnecting on its own is left to its backoff.
  if (!config || devTransport?.state.connected || devTransport?.state.reconnecting) return;
  devTransport?.disconnect();

  const nodeId = `${EXTENSION_NODE_PREFIX}dev-${(await myNodeId()).slice(EXTENSION_NODE_PREFIX.length)}`;
  const node = new HubNode({ nodeId, defaultScope: 'global' });
  const transport = new WebSocketTransport({
    name: 'dev-control',
    url: `ws://127.0.0.1:${config.port}`,
    peerPatterns: ['*'],
    keepAliveMs: 20_000,
    reconnect: { initialDelay: 3000 },
    registrationMessage: { type: 'register', nodeId, securityKey: config.key, ...identity() },
  });
  devTransport = transport;
  devNode = node;
  node.addTransport(transport);
  transport.onStateChange((state) => {
    log(`dev control: ${JSON.stringify(state)}`);
    stateChanged();
  });
  log(`dev control: connecting to 127.0.0.1:${config.port} as ${nodeId}`);
  node.on(EXTENSION_RELOAD, () => {
    log('reload requested over the dev relay');
    chrome.runtime.reload();
  });
  node.on(DEV_CALL, (payload: DevCommand, envelope) => {
    void devHandle(payload).then(
      (value) => node.emit('dev:reply', { value: value ?? null }, { target: envelope.source, replyToId: envelope.id }),
      (e: Error) => node.emit('dev:reply', { error: e.message }, { target: envelope.source, replyToId: envelope.id }),
    );
  });
  // The relay is a dev tool that may not be running: a failed connect is retried by the
  // transport's backoff, and by the next heartbeat after that.
  await transport.connect().catch(() => undefined);
}

const HEARTBEAT = 'bushwhack-dev-heartbeat';

log(`worker started (${chrome.runtime.getManifest().version})`);

if (__DEV__) {
  chrome.runtime.onStartup.addListener(() => void ensureDevControl());
  chrome.runtime.onInstalled.addListener(() => void ensureDevControl());
  chrome.alarms.create(HEARTBEAT, { periodInMinutes: 1 / 6 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT) void ensureDevControl();
  });
  void ensureDevControl();
}

