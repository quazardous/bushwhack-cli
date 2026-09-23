/**
 * Who may ask the worker something. chrome.runtime.onMessage already only hears this
 * extension's own pages and scripts; this says which of them may ask what — the panel its
 * requests, a chat page's content script its own — and drops everything else: another
 * frame, a page of a site no driver claims, an unexpected extension page.
 *
 * The panel is known by its page, not by where it sits: it opens over a chat as the iframe
 * of an overlay, or in a tab of its own (and its address may be a per-session one). Only
 * this extension's pages have an extension URL and this extension's id: a site cannot
 * send the worker anything, let alone pass for the panel.
 */
export interface Sender {
  id?: string;
  url?: string;
  frameId?: number;
  tab?: { id?: number; url?: string };
}

export function accept(sender: Sender, runtime: { id: string; panelPaths: string[]; hosts: string[] }): 'popup' | 'content' | undefined {
  if (sender.id !== runtime.id) return undefined;
  let url: URL;
  try {
    url = new URL(sender.url ?? sender.tab?.url ?? '');
  } catch {
    return undefined;
  }
  if (url.protocol === 'chrome-extension:') return runtime.panelPaths.includes(url.pathname) ? 'popup' : undefined;
  if (!sender.tab || sender.frameId !== 0 || sender.tab.id === undefined) return undefined;
  return runtime.hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`)) ? 'content' : undefined;
}
