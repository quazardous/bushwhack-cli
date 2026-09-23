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

  const lines: string[] = [`title: ${document.title}`, `url: ${location.href}`];
  // A hidden element hides everything under it: reject the whole subtree, not just the node.
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (visible(n as Element) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let seenText = 0;
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
    else if (/^(p|li|td|th|pre|blockquote|label|span|div)$/.test(tag)) {
      // Leaf-ish text only: the text of an element with no element children.
      if (node.children.length === 0) {
        const t = text(node);
        if (t && seenText < 400) {
          lines.push(t);
          seenText++;
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
