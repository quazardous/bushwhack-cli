/**
 * What runs inside the app's page. Each function is injected with
 * chrome.scripting.executeScript, which serializes it by its source: so every function
 * here is self-contained — no imports, no module-level helpers, everything declared inside.
 * They run in the extension's isolated world: the page's DOM, not its JavaScript.
 *
 * Each returns `{ ok: true, data }` or `{ ok: false, error }`, and bounds what it returns.
 */

export type PageResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * A text outline of the page: what a person would see, each actionable element with a
 * selector that finds it again. Bounded to `maxChars`.
 */
export function snapshotPage(maxChars: number): PageResult<string> {
  const selectorOf = (el: Element): string => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      const same = parent ? [...parent.children].filter((c) => c.tagName === node!.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts[0] = `#${node.id}`;
        break;
      }
      node = parent;
    }
    return parts.join(' > ');
  };
  const visible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && !(el as HTMLElement).hidden;
  };
  const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  // A run's text, a line break read as a space: textContent glues "x12<br>2026" together.
  const runText = (el: Element): string => {
    let out = '';
    const nodes = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = nodes.nextNode(); n; n = nodes.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue ?? '';
      else if ((n as Element).tagName === 'BR') out += ' ';
    }
    return out.replace(/\s+/g, ' ').trim().slice(0, 200);
  };

  const lines: string[] = [`title: ${document.title}`, `url: ${location.href}`];
  // A hidden element hides everything under it: reject the whole subtree, not just the node.
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (visible(n as Element) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let seenText = 0;
  // Elements that hold only text and inline markup; and those whose text is already out.
  const INLINE = /^(a|abbr|b|bdi|bdo|br|cite|code|data|dfn|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)$/;
  const texts = new Set<Element>();
  const insideText = (el: Element): boolean => {
    for (let up = el.parentElement; up; up = up.parentElement) if (texts.has(up)) return true;
    return false;
  };
  for (let node = walker.nextNode() as Element | null; node; node = walker.nextNode() as Element | null) {
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) lines.push(`${'#'.repeat(Number(tag[1]))} ${text(node)}`);
    else if (tag === 'a') lines.push(`[link] "${text(node)}" → ${(node as HTMLAnchorElement).getAttribute('href') ?? ''}  (${selectorOf(node)})`);
    else if (tag === 'button' || node.getAttribute('role') === 'button') lines.push(`[button] "${text(node)}"  (${selectorOf(node)})`);
    else if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const field = node as HTMLInputElement;
      const label = field.labels?.[0] ? text(field.labels[0]) : field.getAttribute('aria-label') ?? field.placeholder ?? field.name ?? '';
      const value = field.type === 'password' ? '••••' : String(field.value ?? '').slice(0, 80);
      lines.push(`[${tag}${field.type && tag === 'input' ? `:${field.type}` : ''}] "${label}" = "${value}"  (${selectorOf(node)})`);
    } else if (tag === 'img') lines.push(`[image] "${node.getAttribute('alt') ?? ''}"  (${selectorOf(node)})`);
    else if (/^(p|li|td|th|pre|blockquote|label|span|div|dt|dd|figcaption|caption|summary|legend|b|strong|em|i|code|small|mark)$/.test(tag)) {
      // A run of text: an element whose children are all inline — "<b>Tomate</b> — x12",
      // "Hello <em>big</em> world" — gives its whole text on one line, and none of the
      // elements under it gives it again. (Only leaves were read: the <b> was lost.)
      if ([...node.children].every((c) => INLINE.test(c.tagName.toLowerCase())) && !insideText(node)) {
        const t = runText(node);
        if (t && seenText < 400) {
          lines.push(t);
          seenText++;
          texts.add(node);
        }
      }
    }
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n… (cut at ${maxChars} characters)`;
  return { ok: true, data: out };
}

export interface QueriedElement {
  tag: string;
  text: string;
  visible: boolean;
  attributes: Record<string, string>;
  box: { x: number; y: number; width: number; height: number };
}

export function queryPage(selector: string, limit: number): PageResult<{ count: number; elements: QueriedElement[] }> {
  let found: Element[];
  try {
    found = [...document.querySelectorAll(selector)];
  } catch {
    return { ok: false, error: `"${selector}" is not a valid selector` };
  }
  const elements = found.slice(0, limit).map((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const attributes: Record<string, string> = {};
    for (const a of [...el.attributes].slice(0, 20)) attributes[a.name] = a.value.slice(0, 200);
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      visible: style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0,
      attributes,
      box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    };
  });
  return { ok: true, data: { count: found.length, elements } };
}

export function clickPage(selector: string): PageResult<string> {
  let el: Element | null;
  try {
    el = document.querySelector(selector);
  } catch {
    return { ok: false, error: `"${selector}" is not a valid selector` };
  }
  if (!(el instanceof HTMLElement)) return { ok: false, error: `nothing matches "${selector}"` };
  el.scrollIntoView?.({ block: 'center' });
  el.click();
  return { ok: true, data: `clicked <${el.tagName.toLowerCase()}> "${(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)}"` };
}

/** Set a field the way a framework notices: the native setter, then input and change. */
export function fillPage(selector: string, value: string): PageResult<string> {
  let el: Element | null;
  try {
    el = document.querySelector(selector);
  } catch {
    return { ok: false, error: `"${selector}" is not a valid selector` };
  }
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
    return { ok: false, error: `"${selector}" is not a field` };
  }
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, data: `filled <${el.tagName.toLowerCase()}>` };
}

/** Wait until the selector matches (or the page is idle: no `selector`), up to `timeoutMs`. */
export async function waitPage(selector: string | null, timeoutMs: number): Promise<PageResult<string>> {
  const start = Date.now();
  for (;;) {
    if (selector === null ? document.readyState === 'complete' : (() => {
      try {
        return document.querySelector(selector) !== null;
      } catch {
        return false;
      }
    })()) {
      return { ok: true, data: `ready after ${Date.now() - start} ms` };
    }
    if (Date.now() - start >= timeoutMs) return { ok: false, error: `still waiting after ${timeoutMs} ms` };
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * What the page keeps for itself: its localStorage and sessionStorage keys, its IndexedDB
 * databases — the data of an app with no server. With `key`, that key's value; with `db`
 * and `store`, a store's first entries. Read only, bounded to `maxChars`.
 */
export async function storagePage(key: string, db: string, store: string, maxChars: number): Promise<PageResult<string>> {
  const cut = (s: string): string => (s.length > maxChars ? `${s.slice(0, maxChars)}\n… (cut at ${maxChars} characters)` : s);
  const areas: [string, Storage][] = [
    ['localStorage', window.localStorage],
    ['sessionStorage', window.sessionStorage],
  ];
  const request = <T>(r: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  // An existing database only: opening one that is not there would create it.
  const openDb = (name: string): Promise<IDBDatabase | undefined> =>
    new Promise((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onupgradeneeded = () => {
        r.transaction?.abort();
        resolve(undefined);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => (r.error?.name === 'AbortError' ? resolve(undefined) : reject(r.error));
    });

  try {
    if (key) {
      for (const [name, area] of areas) {
        const value = area.getItem(key);
        if (value !== null) return { ok: true, data: cut(`${name} "${key}" (${value.length} characters):\n${value}`) };
      }
      return { ok: false, error: `no key "${key}" in localStorage or sessionStorage — page:storage alone lists them` };
    }
    if (db) {
      if (typeof indexedDB === 'undefined') return { ok: false, error: 'this page has no IndexedDB' };
      const base = await openDb(db);
      if (!base) return { ok: false, error: `no IndexedDB database "${db}" — page:storage alone lists them` };
      try {
        if (!store) return { ok: true, data: `IndexedDB "${db}": ${[...base.objectStoreNames].join(', ') || 'no store'}` };
        if (!base.objectStoreNames.contains(store)) return { ok: false, error: `no store "${store}" in "${db}"; its stores: ${[...base.objectStoreNames].join(', ') || 'none'}` };
        const objects = base.transaction(store, 'readonly').objectStore(store);
        const [count, first] = await Promise.all([request(objects.count()), request(objects.getAll(null, 20))]);
        const lines = first.map((entry) => JSON.stringify(entry));
        return { ok: true, data: cut(`IndexedDB "${db}" / "${store}": ${count} entr${count === 1 ? 'y' : 'ies'}${count > first.length ? `, the first ${first.length}` : ''}\n${lines.join('\n')}`) };
      } finally {
        base.close();
      }
    }
    const lines: string[] = [];
    for (const [name, area] of areas) {
      const keys = Array.from({ length: area.length }, (_, i) => area.key(i)).filter((k): k is string => k !== null);
      lines.push(keys.length ? `${name}:` : `${name}: empty`);
      for (const k of keys) lines.push(`  ${k}  (${(area.getItem(k) ?? '').length} characters)`);
    }
    const hasDb = typeof indexedDB !== 'undefined';
    const listed = hasDb && typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    lines.push(listed.length ? 'IndexedDB:' : 'IndexedDB: none');
    for (const info of listed) {
      if (!info.name) continue;
      const base = await openDb(info.name);
      if (!base) continue;
      const stores = [...base.objectStoreNames];
      const counts = await Promise.all(stores.map((s) => request(base.transaction(s, 'readonly').objectStore(s).count()).catch(() => -1)));
      base.close();
      lines.push(`  ${info.name}: ${stores.map((s, i) => `${s} (${counts[i] < 0 ? '?' : counts[i]})`).join(', ') || 'no store'}`);
    }
    return { ok: true, data: cut(lines.join('\n')) };
  } catch (e) {
    return { ok: false, error: `the page's storage could not be read: ${(e as Error).message}` };
  }
}
