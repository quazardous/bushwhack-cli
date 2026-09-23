/**
 * The controller's boundary: only the session's tab, only on the app's origins, checked
 * before and after every action. Each refusal was checked to fail with its guard removed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadSummary, PageController, type Browser, type TabInfo, type TabStore } from './controller.js';
import { allowed, urlFor } from './origin.js';

const APP = 'http://demo.localhost';

class FakeBrowser implements Browser {
  tabs = new Map<number, TabInfo>();
  next = 1;
  /** What running a function in the tab does: return this, and move the tab if asked. */
  onRun: (tabId: number) => unknown = () => ({ ok: true, data: 'page text' });
  opened: string[] = [];
  recording = true;

  async getTab(id: number) {
    return this.tabs.get(id);
  }
  async openTab(url: string) {
    const id = this.next++;
    this.tabs.set(id, { id, url, title: 'Demo' });
    this.opened.push(url);
    return id;
  }
  /** A tab left in the session's group by an earlier run of the extension. */
  inGroup: number | undefined;
  async findTab() {
    return this.inGroup;
  }
  async navigate(id: number, url: string) {
    this.tabs.set(id, { ...this.tabs.get(id)!, url });
  }
  async waitLoaded() {}
  async run(tabId: number) {
    return this.onRun(tabId) as never;
  }
  async ensureRecorder() {}
  async readRecorder() {
    return { console: [{ level: 'error', text: 'boom', at: 1 }], network: [], recording: this.recording };
  }
  async screenshot() {
    return 'data:image/png;base64,AAAA';
  }
}

class MemoryTabs implements TabStore {
  map = new Map<string, number>();
  async get(s: string) {
    return this.map.get(s);
  }
  async set(s: string, id: number) {
    this.map.set(s, id);
  }
}

let browser: FakeBrowser;
let tabs: MemoryTabs;
let page: PageController;

const request = (action: string, args: Record<string, string> = {}) => ({
  session: 'session:demo',
  name: 'demo',
  origins: [APP],
  action: action as never,
  args,
});

beforeEach(() => {
  browser = new FakeBrowser();
  tabs = new MemoryTabs();
  page = new PageController(browser, tabs);
});

describe('origin rules', () => {
  it('take a path, never an origin', () => {
    expect(urlFor(APP, '/about?x=1')).toBe('http://demo.localhost/about?x=1');
    expect(() => urlFor(APP, '//evil.example/x')).toThrow(/single \//);
    expect(() => urlFor(APP, 'http://evil.example/')).toThrow(/single \//);
    expect(() => urlFor(APP, '/\\evil.example')).toThrow(/single \//);
  });

  it('compare origins, port included', () => {
    expect(allowed('http://demo.localhost/x', [APP])).toBe(true);
    expect(allowed('http://demo.localhost:8480/x', [APP])).toBe(false);
    expect(allowed('http://other.localhost/', [APP])).toBe(false);
  });
});

describe('PageController', () => {
  it('opens the app in its own tab, once, and reuses it', async () => {
    expect((await page.run(request('open', { path: '/' }))).status).toBe('ok');
    await page.run(request('open', { path: '/about' }));
    expect(browser.opened).toEqual(['http://demo.localhost/']);
    expect(browser.tabs.get(1)?.url).toBe('http://demo.localhost/about');
  });

  it('says how the load went: the console errors and failed requests, or that there were none', async () => {
    const opened = await page.run(request('open', { path: '/' }));
    expect(opened.content).toContain('1 console error:\n  boom');
    expect(opened.content).toContain('page:console and page:network give them all');
    expect(opened.meta).toMatchObject({ consoleErrors: 1, failedRequests: 0 });
    expect(loadSummary([], [])).toBe('\nloaded with no console error and no failed request');
    const five = Array.from({ length: 5 }, (_, i) => ({ method: 'GET', url: `/f${i}.js`, status: i ? 404 : 0 }));
    expect(loadSummary([], five)).toContain('5 requests failed:\n  GET /f0.js → failed\n  GET /f1.js → 404\n  GET /f2.js → 404\n  … 2 more');
  });

  it('takes back the app tab it left in the group when its memory was cleared', async () => {
    browser.tabs.set(42, { id: 42, url: 'http://demo.localhost/old' });
    browser.inGroup = 42;
    await page.run(request('open', { path: '/new' }));
    expect(browser.opened).toEqual([]);
    expect(browser.tabs.get(42)?.url).toBe('http://demo.localhost/new');
    expect(await tabs.get('session:demo')).toBe(42);
  });

  it('takes back the app tab still in the group when its memory is gone, for any action', async () => {
    // The extension was reloaded: its table of tabs is empty, the app's tab is still there.
    browser.tabs.set(7, { id: 7, url: 'http://demo.localhost/list' });
    browser.inGroup = 7;
    browser.onRun = () => ({ ok: true, data: 'clicked <button>' });
    expect(await page.run(request('click', { selector: '#go' }))).toMatchObject({ status: 'ok' });
    expect(await tabs.get('session:demo')).toBe(7);
  });

  it('says why no page is open, and what brings it back', async () => {
    await page.run(request('open', { path: '/standalone/index.html' }));
    browser.tabs.clear();
    tabs.map.clear();
    expect(await page.run(request('click', { selector: '#go' }))).toMatchObject({
      status: 'error',
      content: expect.stringMatching(/its tab was closed\. page:open \/standalone\/index\.html brings it back/),
    });
  });

  it('refuses to act before a page is open', async () => {
    expect(await page.run(request('snapshot'))).toMatchObject({ status: 'error', content: expect.stringMatching(/page:open first/) });
  });

  it('refuses to act on a tab that is no longer on the app', async () => {
    await page.run(request('open'));
    browser.tabs.set(1, { id: 1, url: 'https://mail.example/inbox' });
    const out = await page.run(request('snapshot'));
    expect(out.status).toBe('error');
    expect(out.content).toMatch(/left the app/);
  });

  it('throws away what was read when the page left the app during the action', async () => {
    await page.run(request('open'));
    browser.onRun = (tabId) => {
      browser.tabs.set(tabId, { id: tabId, url: 'https://mail.example/inbox' });
      return { ok: true, data: 'SECRET MAIL CONTENT' };
    };
    const out = await page.run(request('snapshot'));
    expect(out.status).toBe('error');
    expect(out.content).toMatch(/left the app during snapshot/);
    expect(JSON.stringify(out)).not.toContain('SECRET MAIL CONTENT');
  });

  it('refuses a page:open when the app redirects away from itself', async () => {
    browser.openTab = async (url) => {
      browser.tabs.set(7, { id: 7, url: 'https://elsewhere.example/' });
      browser.opened.push(url);
      return 7;
    };
    expect((await page.run(request('open'))).content).toMatch(/redirected away/);
  });

  it('refuses a page:open on an error page: the model is told it is not the app', async () => {
    browser.onRun = () => 404;
    const outcome = await page.run(request('open', { path: '/' }));
    expect(outcome.status).toBe('error');
    expect(outcome.content).toMatch(/HTTP 404.*no such page — or the app is not running \(app:status/);
    browser.onRun = () => 200;
    const fine = await page.run(request('open', { path: '/' }));
    expect(fine).toMatchObject({ status: 'ok', meta: { http: 200 } });
  });

  it('returns a snapshot, console events and a screenshot when all stays on the app', async () => {
    await page.run(request('open'));
    expect(await page.run(request('snapshot'))).toEqual({ status: 'ok', content: 'page text' });
    expect((await page.run(request('console'))).content).toBe('[error] boom');
    expect((await page.run(request('screenshot'))).image).toBe('data:image/png;base64,AAAA');
  });

  it('says when nothing could be recorded, rather than an empty list', async () => {
    await page.run(request('open'));
    expect((await page.run(request('network'))).content).toBe('no requests');
    browser.recording = false;
    expect((await page.run(request('network'))).content).toMatch(/loaded before recording began/);
  });

  it('says there is no app when the session has none', async () => {
    expect((await page.run({ ...request('open'), origins: [] })).content).toMatch(/app:create first/);
  });
});

describe('the page:* tools and the actions the extension accepts', () => {
  it('are the same list: a new tool cannot be refused as malformed', async () => {
    const { PAGE_TOOLS } = await import('./tools.js');
    const { PAGE_ACTIONS } = await import('./types.js');
    expect(PAGE_TOOLS.map((t) => t.name.slice('page:'.length)).sort()).toEqual([...PAGE_ACTIONS].sort());
  });
});
