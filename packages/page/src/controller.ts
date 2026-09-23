/**
 * The page:* tools, run against the browser: one tab per session, opened by the
 * extension, and every action between two origin checks.
 *
 * The check after the action is the one that matters, like `realpath` after resolving a
 * path: a click, a redirect or a script can move the tab while the action runs, and
 * whatever was read from a page outside the app must not reach the model. So when the tab
 * is no longer on the app afterwards, the action's result is thrown away.
 */
import { clickPage, fillPage, queryPage, snapshotPage, waitPage, type PageResult } from './dom.js';
import { allowed, originOf, urlFor } from './origin.js';
import type { PageOutcome, PageRequest } from './types.js';

export type { PageAction, PageOutcome, PageRequest } from './types.js';

export interface TabInfo {
  id: number;
  url?: string;
  title?: string;
}

export interface RecordedEvents {
  console: { level: string; text: string; at: number }[];
  network: { method: string; url: string; status: number; ms: number; at: number }[];
  /** False when the page was loaded before the recorder was registered: nothing was seen. */
  recording: boolean;
}

const NOT_RECORDING = ' (the page was loaded before recording began — page:open loads it again, recorded)';

/** What the controller needs from the browser; chrome.* in the extension, a fake in tests. */
export interface Browser {
  getTab(tabId: number): Promise<TabInfo | undefined>;
  /** Opens in the background, next to the session's chat, grouped under its name. */
  openTab(url: string, owner: { session: string; name: string }): Promise<number>;
  /**
   * A tab of the app the extension opened earlier for this session but no longer knows
   * (its memory is cleared when it restarts): found in the session's tab group.
   */
  findTab(owner: { session: string; name: string }, origins: string[]): Promise<number | undefined>;
  navigate(tabId: number, url: string): Promise<void>;
  /** Resolves when the tab has finished loading, or after timeoutMs. */
  waitLoaded(tabId: number, timeoutMs: number): Promise<void>;
  run<A extends unknown[], R>(tabId: number, fn: (...args: A) => R | Promise<R>, args: A): Promise<Awaited<R>>;
  /** Make sure the console/network recorder is injected into pages of these origins, from load. */
  ensureRecorder(origins: string[]): Promise<void>;
  readRecorder(tabId: number): Promise<RecordedEvents>;
  /** A picture of the page (or of one element), rendered from the DOM: a data: URL. */
  screenshot(tabId: number, selector: string | undefined): Promise<string>;
}

/** Which tab belongs to which session; kept across service worker restarts. */
export interface TabStore {
  get(session: string): Promise<number | undefined>;
  set(session: string, tabId: number): Promise<void>;
}

export const LIMITS = { snapshotChars: 12_000, queryElements: 20, events: 50, waitMs: 30_000, loadMs: 15_000 } as const;

const fail = (content: string): PageOutcome => ({ status: 'error', content });

function unwrap<T>(result: PageResult<T>): { ok: true; data: T } | { ok: false; outcome: PageOutcome } {
  return result.ok ? result : { ok: false, outcome: fail(result.error) };
}

export class PageController {
  constructor(
    private readonly browser: Browser,
    private readonly tabs: TabStore,
  ) {}

  async run(request: PageRequest): Promise<PageOutcome> {
    if (request.origins.length === 0) return fail('the project has no app to look at — app:create first');
    if (request.action === 'open') return this.open(request);

    const tabId = await this.tabs.get(request.session);
    const tab = tabId === undefined ? undefined : await this.browser.getTab(tabId);
    if (!tab) return fail('no page is open — page:open first');
    if (!allowed(tab.url, request.origins)) {
      return fail(`the page left the app (it is on ${originOf(tab.url) ?? 'no page'} now) — page:open brings it back`);
    }

    const outcome = await this.act(tab.id, request);

    // The check that matters: the action may have moved the tab off the app. Nothing read
    // from elsewhere goes back to the model.
    const after = await this.browser.getTab(tab.id);
    if (!after || !allowed(after.url, request.origins)) {
      return fail(`the page left the app during ${request.action} (now ${originOf(after?.url) ?? 'closed'}); nothing was read from it — page:open brings it back`);
    }
    return outcome;
  }

  private async open(request: PageRequest): Promise<PageOutcome> {
    let url: string;
    try {
      url = urlFor(request.origins[0], String(request.args.path ?? '/'));
    } catch (e) {
      return fail((e as Error).message);
    }
    await this.browser.ensureRecorder(request.origins);
    const owner = { session: request.session, name: request.name };
    const known = (await this.tabs.get(request.session)) ?? (await this.browser.findTab(owner, request.origins));
    const existing = known === undefined ? undefined : await this.browser.getTab(known);
    let tabId: number;
    if (existing) {
      tabId = existing.id;
      await this.tabs.set(request.session, tabId);
      await this.browser.navigate(tabId, url);
    } else {
      tabId = await this.browser.openTab(url, owner);
      await this.tabs.set(request.session, tabId);
    }
    await this.browser.waitLoaded(tabId, LIMITS.loadMs);
    const tab = await this.browser.getTab(tabId);
    if (!tab || !allowed(tab.url, request.origins)) {
      return fail(`the app redirected away from itself (to ${originOf(tab?.url) ?? 'nowhere'}); the page is not shown`);
    }
    // An error page opens like any other: the model must not take it for the app.
    const code = await this.browser.run(tabId, () => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.responseStatus ?? 0, []).catch(() => 0);
    if (typeof code === 'number' && code >= 400) {
      return fail(
        `${tab.url ?? url} answered HTTP ${code}${tab.title ? ` ("${tab.title}")` : ''} — not the app's page: ` +
          (code === 404
            ? 'no such page — or the app is not running (app:status says which)'
            : code >= 502
              ? 'the app is not answering (app:status, app:logs say why)'
              : 'the app failed on it (app:logs says why)'),
      );
    }
    return {
      status: 'ok',
      meta: { url: tab.url ?? url, title: tab.title ?? '', ...(typeof code === 'number' && code > 0 ? { http: code } : {}) },
      content: `opened ${tab.url ?? url}`,
    };
  }

  private async act(tabId: number, request: PageRequest): Promise<PageOutcome> {
    const a = request.args;
    const str = (key: string): string => String(a[key] ?? '');
    switch (request.action) {
      case 'snapshot': {
        const r = unwrap(await this.browser.run(tabId, snapshotPage, [LIMITS.snapshotChars]));
        return r.ok ? { status: 'ok', content: r.data } : r.outcome;
      }
      case 'query': {
        const r = unwrap(await this.browser.run(tabId, queryPage, [str('selector'), LIMITS.queryElements]));
        if (!r.ok) return r.outcome;
        const lines = r.data.elements.map(
          (e) => `<${e.tag}>${e.visible ? '' : ' (hidden)'} "${e.text}" ${JSON.stringify(e.attributes)} @${e.box.x},${e.box.y} ${e.box.width}×${e.box.height}`,
        );
        return { status: 'ok', meta: { matches: r.data.count, ...(r.data.count > r.data.elements.length ? { shown: r.data.elements.length } : {}) }, content: lines.join('\n') };
      }
      case 'click': {
        const r = unwrap(await this.browser.run(tabId, clickPage, [str('selector')]));
        if (!r.ok) return r.outcome;
        await this.browser.waitLoaded(tabId, LIMITS.loadMs);
        return { status: 'ok', content: r.data };
      }
      case 'fill': {
        const r = unwrap(await this.browser.run(tabId, fillPage, [str('selector'), str('value')]));
        return r.ok ? { status: 'ok', content: r.data } : r.outcome;
      }
      case 'wait': {
        const selector = a.selector === undefined || a.selector === '' ? null : str('selector');
        const timeout = Math.min(Number(a.timeout ?? 5) * 1000, LIMITS.waitMs);
        const r = unwrap(await this.browser.run(tabId, waitPage, [selector, timeout]));
        return r.ok ? { status: 'ok', content: r.data } : r.outcome;
      }
      case 'console': {
        const recorded = await this.browser.readRecorder(tabId);
        const events = recorded.console.slice(-LIMITS.events);
        const lines = events.map((e) => `[${e.level}] ${e.text}`).join('\n');
        return { status: 'ok', meta: { messages: events.length }, content: lines || `no console messages${recorded.recording ? '' : NOT_RECORDING}` };
      }
      case 'network': {
        const recorded = await this.browser.readRecorder(tabId);
        const events = recorded.network.slice(-LIMITS.events);
        const lines = events.map((e) => `${e.method} ${e.url} → ${e.status || 'failed'} (${e.ms} ms)`).join('\n');
        return { status: 'ok', meta: { requests: events.length }, content: lines || `no requests${recorded.recording ? '' : NOT_RECORDING}` };
      }
      case 'screenshot': {
        const image = await this.browser.screenshot(tabId, a.selector === undefined || a.selector === '' ? undefined : str('selector'));
        return { status: 'ok', meta: { image: 'attached' }, content: 'a picture of the page, rendered from its DOM, is attached', image };
      }
      default:
        return fail(`unknown page action ${String(request.action)}`);
    }
  }
}
