/** What the daemon and the extension exchange for one page:* call. No DOM here: the daemon imports it. */

/** Every action a page:* tool asks for: the extension accepts these and no other. */
export const PAGE_ACTIONS = ['open', 'snapshot', 'query', 'click', 'fill', 'wait', 'console', 'network', 'screenshot', 'storage'] as const;
export type PageAction = (typeof PAGE_ACTIONS)[number];

export interface PageRequest {
  /** The session's node id: whose tab. */
  session: string;
  /** The session name, for the tab group. */
  name: string;
  /** The app's origins, from the daemon. The first is where page:open goes. */
  origins: string[];
  action: PageAction;
  args: Record<string, string | number | boolean | undefined>;
}

export interface PageOutcome {
  status: 'ok' | 'error';
  content?: string;
  meta?: Record<string, string | number | boolean>;
  /** A data: URL, for page:screenshot. */
  image?: string;
}
