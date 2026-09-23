/**
 * The page controller's browser: chrome.tabs, chrome.scripting and a tab group per session.
 * Everything that decides — origins, bounds, the checks around each action — is in
 * @bushwhack/page and tested there; this is only the wiring.
 */
import { PAGE_ACTIONS, type Browser, type PageRequest, type RecordedEvents, type TabInfo, type TabStore } from '@bushwhack/page';
import { joinSessionGroup, sessionWindow, titleOf } from './tab-groups.js';

const RECORDER_ID = 'bushwhack-page-recorder';

/** Tab ids restart with the browser: kept for the browser session only. */
export const sessionTabs: TabStore = {
  async get(session) {
    const all = (await chrome.storage.session.get('pageTabs')).pageTabs as Record<string, number> | undefined;
    return all?.[session];
  },
  async set(session, tabId) {
    const all = ((await chrome.storage.session.get('pageTabs')).pageTabs as Record<string, number> | undefined) ?? {};
    await chrome.storage.session.set({ pageTabs: { ...all, [session]: tabId } });
  },
};

/** Match patterns ignore ports: one per host. */
const patternOf = (origin: string): string => {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
};

export const chromeBrowser: Browser = {
  async getTab(tabId): Promise<TabInfo | undefined> {
    try {
      const tab = await chrome.tabs.get(tabId);
      return { id: tabId, url: tab.url ?? tab.pendingUrl, title: tab.title };
    } catch {
      return undefined;
    }
  },

  async openTab(url, owner) {
    // In the window where the project's chat is, in the project's group.
    const windowId = await sessionWindow(owner.session);
    const tab = await chrome.tabs.create({ url, active: false, ...(windowId !== undefined ? { windowId } : {}) });
    const tabId = tab.id!;
    // A group is a convenience; the tab works without one.
    await joinSessionGroup(tabId, owner.session, owner.name).catch(() => undefined);
    return tabId;
  },

  async findTab(owner, origins) {
    const groups = await chrome.tabGroups.query({ title: titleOf(owner.name) });
    for (const group of groups) {
      for (const tab of await chrome.tabs.query({ groupId: group.id })) {
        if (tab.id !== undefined && origins.some((o) => (tab.url ?? '').startsWith(`${o}/`))) return tab.id;
      }
    }
    return undefined;
  },

  async navigate(tabId, url) {
    await chrome.tabs.update(tabId, { url });
  },

  async waitLoaded(tabId, timeoutMs) {
    const until = Date.now() + timeoutMs;
    // Give a navigation the time to start, so "complete" is not the previous page's.
    await new Promise((r) => setTimeout(r, 150));
    while (Date.now() < until) {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab || tab.status === 'complete') return;
      await new Promise((r) => setTimeout(r, 150));
    }
  },

  async run(tabId, fn, args) {
    const [first] = await chrome.scripting.executeScript({ target: { tabId }, func: fn as never, args: args as never });
    return first?.result as never;
  },

  async ensureRecorder(origins) {
    const matches = [...new Set(origins.map(patternOf))];
    const [existing] = await chrome.scripting.getRegisteredContentScripts({ ids: [RECORDER_ID] });
    const all = [...new Set([...(existing?.matches ?? []), ...matches])];
    const script = { id: RECORDER_ID, matches: all, js: ['page-recorder.js'], runAt: 'document_start' as const, world: 'MAIN' as const, allFrames: false };
    if (!existing) await chrome.scripting.registerContentScripts([script]);
    else if (all.length !== existing.matches?.length) await chrome.scripting.updateContentScripts([script]);
  },

  async readRecorder(tabId): Promise<RecordedEvents> {
    const [first] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const log = (window as unknown as { __bushwhackPage?: Omit<RecordedEvents, 'recording'> }).__bushwhackPage;
        // The document and what it loaded (scripts, styles, images) come from the browser's
        // own timing entries; fetch and XHR from the recorder, which sees their method.
        type Timed = PerformanceResourceTiming & { responseStatus?: number };
        const origin = performance.timeOrigin;
        const loaded = [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')]
          .map((e) => e as Timed)
          .filter((e) => e.initiatorType !== 'fetch' && e.initiatorType !== 'xmlhttprequest')
          .map((e) => ({ method: 'GET', url: e.name, status: e.responseStatus ?? 0, ms: Math.round(e.duration), at: Math.round(origin + e.startTime) }));
        const network = [...loaded, ...(log?.network ?? [])].sort((a, b) => a.at - b.at).slice(-200);
        return { console: log?.console.slice(-200) ?? [], network, recording: Boolean(log) };
      },
    });
    // The page's own world wrote this: take only the fields, as strings and numbers.
    const raw = (first?.result ?? {}) as Partial<RecordedEvents>;
    const str = (v: unknown): string => String(v ?? '').slice(0, 500);
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      console: (Array.isArray(raw.console) ? raw.console : []).map((e) => ({ level: str(e?.level).slice(0, 10), text: str(e?.text), at: num(e?.at) })),
      network: (Array.isArray(raw.network) ? raw.network : []).map((e) => ({ method: str(e?.method).slice(0, 10), url: str(e?.url), status: num(e?.status), ms: num(e?.ms), at: num(e?.at) })),
      recording: raw.recording === true,
    };
  },

  async screenshot(tabId, selector) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['page-shot.js'] });
    const [first] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string | null) => (globalThis as unknown as { __bushwhackShot: (s: string | null) => Promise<unknown> }).__bushwhackShot(sel),
      args: [selector ?? null],
    });
    const shot = first?.result as { ok: boolean; data?: string; error?: string } | undefined;
    if (!shot?.ok || typeof shot.data !== 'string') throw new Error(shot?.error ?? 'no picture');
    return shot.data;
  },
};

// From the tools' own list: a new page:* tool is accepted here without a second list to forget.
const ACTIONS = new Set<string>(PAGE_ACTIONS);

/** An origin the extension will act on: the local edge's, never anything on the internet. */
function localOrigin(origin: unknown): boolean {
  if (typeof origin !== 'string') return false;
  try {
    const u = new URL(origin);
    return u.origin === origin && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname.endsWith('.localhost'));
  } catch {
    return false;
  }
}

export function isPageRequest(payload: unknown, session: string): payload is PageRequest {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return (
    p.session === session &&
    typeof p.name === 'string' &&
    p.name.length <= 100 &&
    typeof p.action === 'string' &&
    ACTIONS.has(p.action) &&
    Array.isArray(p.origins) &&
    p.origins.length <= 10 &&
    p.origins.every(localOrigin) &&
    !!p.args &&
    typeof p.args === 'object' &&
    Object.values(p.args).every((v) => v === undefined || ['string', 'number', 'boolean'].includes(typeof v))
  );
}
