/**
 * The app page's console and network, recorded from the first script on: registered for
 * the app's origins only, in the page's own world, at document_start. page:console and
 * page:network read the buffers; nothing leaves the page otherwise. Its native dialogs
 * (alert, confirm, prompt) answer at once instead of freezing it, and are recorded.
 */
(() => {
  const KEY = '__bushwhackPage';
  const w = window as unknown as Record<string, unknown>;
  if (w[KEY]) return;
  const KEEP = 200;
  const TEXT = 500;
  const log = { console: [] as { level: string; text: string; at: number }[], network: [] as { method: string; url: string; status: number; ms: number; at: number }[] };
  Object.defineProperty(w, KEY, { value: log, enumerable: false });

  const push = <T>(list: T[], item: T): void => {
    list.push(item);
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
  };
  const show = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const note = (level: string, parts: unknown[]): void =>
    push(log.console, { level, text: parts.map(show).join(' ').slice(0, TEXT), at: Date.now() });

  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      note(level, args);
      original(...args);
    };
  }
  // The page's own dialogs would freeze it — its scripts, and every page:* call after —
  // until someone clicks: in the tab the model drives, nobody does. They answer at once,
  // as a person clicking OK would, and are told in page:console.
  window.alert = (message?: unknown) => note('dialog', [`alert: ${show(message ?? '')}`]);
  window.confirm = (message?: string) => {
    note('dialog', [`confirm: ${show(message ?? '')} → OK (answered by bushwhack)`]);
    return true;
  };
  window.prompt = (message?: string, value?: string) => {
    note('dialog', [`prompt: ${show(message ?? '')} → ${value === undefined ? 'cancelled' : JSON.stringify(value)} (answered by bushwhack)`]);
    return value ?? null;
  };

  addEventListener('error', (e) => note('error', [e.message || 'error', e.filename ? `(${e.filename}:${e.lineno})` : '']));
  // What the page loads itself — a <script src>, a stylesheet, an image — goes through no
  // fetch: a missing file or an unreachable CDN is only an error event on its element, seen
  // here in the capture phase (it does not bubble).
  addEventListener(
    'error',
    (e) => {
      const el = e.target as (Element & { src?: string; href?: string }) | null;
      if (!el || el === (window as unknown) || !(el instanceof Element)) return;
      const url = el.src || el.href || el.getAttribute('src') || el.getAttribute('href') || '';
      note('error', [`failed to load <${el.tagName.toLowerCase()}> ${url}`]);
    },
    true,
  );
  addEventListener('unhandledrejection', (e) => note('error', ['unhandled rejection:', e.reason]));

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = performance.now();
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const url = (input instanceof Request ? input.url : String(input)).slice(0, TEXT);
    try {
      const response = await originalFetch(input, init);
      push(log.network, { method, url, status: response.status, ms: Math.round(performance.now() - started), at: Date.now() });
      return response;
    } catch (e) {
      push(log.network, { method, url, status: 0, ms: Math.round(performance.now() - started), at: Date.now() });
      throw e;
    }
  };

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const seen = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    seen.set(this, { method: method.toUpperCase(), url: String(url).slice(0, TEXT) });
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const started = performance.now();
    this.addEventListener('loadend', () => {
      const what = seen.get(this);
      if (what) push(log.network, { ...what, status: this.status, ms: Math.round(performance.now() - started), at: Date.now() });
    });
    return send.call(this, body);
  };
})();
