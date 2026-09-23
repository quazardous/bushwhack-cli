/**
 * The page:* tools, from the daemon's side: which origins are the app's, and which browser
 * runs the action.
 *
 * The daemon decides the origins — the app's routes, as octopod reports them — and sends
 * them with every request; the extension never widens them. The action goes back to the
 * extension that sent the call (its node), or to any extension on the relay when the call
 * came from the CLI.
 */
import { EXTENSION_NODE_PREFIX } from '@bushwhack/protocol';
import { pageAction, type PageOutcome, type PageRequest } from '@bushwhack/page/daemon';
import type { ToolOutcome, ToolRun } from './dispatcher.js';
import type { SessionInfo } from './session.js';

/** Long enough for page:wait's longest wait plus a page load. */
export const PAGE_TIMEOUT_MS = 60_000;

export type AskBrowser = (target: string, request: PageRequest) => Promise<unknown>;

function isOutcome(payload: unknown): payload is PageOutcome {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return (
    (p.status === 'ok' || p.status === 'error') &&
    (p.content === undefined || typeof p.content === 'string') &&
    (p.image === undefined || (typeof p.image === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(p.image)))
  );
}

export class PageHost {
  constructor(
    private readonly session: SessionInfo,
    /** The app's origins right now; empty when there is no app. */
    private readonly origins: () => Promise<string[]>,
    private readonly ask: AskBrowser,
  ) {}

  async run(call: ToolRun & { from: string }): Promise<ToolOutcome> {
    const action = pageAction(call.tool);
    if (!action) return { status: 'error', content: `unknown tool ${call.tool}` };
    const origins = await this.origins();
    if (origins.length === 0) return { status: 'error', content: 'there is no app to look at — app:create first' };

    const target = call.from.startsWith(EXTENSION_NODE_PREFIX) ? call.from : `${EXTENSION_NODE_PREFIX}*`;
    const request: PageRequest = { session: this.session.nodeId, name: this.session.name, origins, action, args: call.args };
    let payload: unknown;
    try {
      payload = await this.ask(target, request);
    } catch {
      return { status: 'error', content: 'no browser answered — page:* tools run through the bushwhack extension, paired with this project' };
    }
    if (payload && typeof payload === 'object' && 'error' in payload) {
      return { status: 'error', content: String((payload as { error: unknown }).error) };
    }
    if (!isOutcome(payload)) return { status: 'error', content: 'the browser answered something that is not a page result' };
    const { status, content, meta, image } = payload;
    return { status, ...(content !== undefined ? { content } : {}), ...(meta ? { meta } : {}), ...(image ? { image } : {}) };
  }
}

/** The origins of an app's routes: `http://demo.localhost/` → `http://demo.localhost`. */
export function originsOf(urls: string[]): string[] {
  const out = new Set<string>();
  for (const url of urls) {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') out.add(u.origin);
    } catch {
      // not a URL: not an origin
    }
  }
  return [...out];
}
