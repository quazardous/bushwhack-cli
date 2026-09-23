/**
 * Messages inside the extension: content script ↔ service worker ↔ popup. The chat page
 * never sees these; the page only ever sees what the driver writes into its composer.
 */
import type { Picture, RefusedCall, ToolsCallReply } from '@bushwhack/protocol';

export interface DiscoveredSession {
  port: number;
  session: string;
  folder: string;
  nodeId: string;
  /** The service it belongs to, when it is one of a service's projects: one code pairs them all. */
  service?: string;
  /** That service's instance name. */
  instance?: string;
  /** The project's app address, when it has an app (`http://<project>.localhost…` only). */
  url?: string;
  paired: boolean;
  /** Conversations bound to this session, and the tab each is open in, if any. */
  chats: { conversation: string; tabId?: number; title?: string }[];
  /** The `bushwhack` terminals following its chat, as its service last said. */
  terminals?: TerminalItem[];
  /** Where its approvals go. */
  approvals?: 'here' | 'terminal' | 'browser';
}

/** A terminal following a project's chat, as the panel lists it. */
export interface TerminalItem {
  id: string;
  /** It takes the project's approvals (--approve-here). */
  approves: boolean;
  /** What it said of itself: its pid, its tty. */
  label?: string;
  since: number;
}

export interface TabInfo {
  driver: string | null;
  /** `<host>/<conversation id>`, or null on a fresh chat. */
  conversation: string | null;
  /** The session this tab's conversation (or the tab itself, before it has one) is bound to. */
  bound: { nodeId: string; session: string } | null;
}

/** Sent by the content script. */
export type ContentRequest =
  | { type: 'calls'; conversation: string; calls: (string | RefusedCall)[]; pictures?: Picture[] }
  /** A generated picture the page may not read itself (no CORS): fetched by the worker, from a driver's image hosts only. */
  | { type: 'picture'; url: string }
  /** `born`: the conversation was born in this page — see arrival.ts. */
  | { type: 'status'; conversation: string | null; born?: boolean }
  /** What the chat shows, for a terminal following it: the answer, calls, results. */
  | { type: 'chat-event'; conversation: string | null; event: { kind: 'answer' | 'calls' | 'results' | 'notice'; text?: string; done?: boolean; items?: { id: string | null; tool: string; detail?: string; status?: string }[] } };

/** Sent by the popup. */
export type PopupRequest =
  | { type: 'discover' }
  | { type: 'pair'; port: number; nodeId: string; code: string }
  | { type: 'forget'; nodeId: string }
  | { type: 'tab'; tabId: number }
  | { type: 'bind'; tabId: number; nodeId: string }
  | { type: 'unbind'; tabId: number }
  | { type: 'manifest'; tabId: number }
  | { type: 'settings'; autoSend: boolean }
  | { type: 'focus'; tabId: number }
  | { type: 'links' }
  /** The calls waiting for a yes in this browser, and opening one's approval page. */
  | { type: 'approvals' }
  | { type: 'review'; key: string }
  /** Close a terminal following a project's chat — confirmed in the panel first. */
  | { type: 'close-terminal'; nodeId: string; terminal: string };

/** A call waiting for a yes, as the panel lists it. */
export interface ApprovalItem {
  key: string;
  project: string;
  id: string;
  tool: string;
  summary: string;
}

/** Sent by the approval page, approve.html — by nothing else. */
export type ApprovalPageRequest =
  | { type: 'approval'; key: string }
  /** `remember`: one of the request's scopes — its pattern, or true for the whole tool. */
  | { type: 'approval-answer'; key: string; verdict: 'yes' | 'no'; remember?: string | true };

/** Relay connections as the popup shows them. */
export interface Links {
  /** The dev control relay, in dev builds; null in production builds. */
  dev: { port: number; connected: boolean } | null;
  /** Per paired session node id: whether its relay connection is up right now. */
  sessions: Record<string, boolean>;
}

/** Sent by the service worker to a tab's content script. */
export type TabCommand =
  | { type: 'whoami' }
  /** Open the panel over the page, or close it if open; answers true when done. */
  | { type: 'panel'; tabId: number }
  /** Look at the page now: sent by the worker, whose timers a hidden tab does not slow. */
  | { type: 'tick' }
  /** Put text in the composer; answers 'written', 'not-empty', or 'no-composer' (the page is still loading it). */
  | { type: 'write'; text: string }
  /** A prompt from the operator's terminal: written and sent. Answers 'sent', 'busy' (the operator is typing here), 'not-empty', 'no-composer' or 'not-sent'. */
  | { type: 'prompt'; text: string }
  /** Mark every call now in the page as handled: binding a conversation must not replay its past. */
  | { type: 'baseline' }
  // Development builds only: how the dev control channel observes and drives a chat.
  | { type: 'dev:dump' }
  | { type: 'dev:type'; text: string }
  | { type: 'dev:send' }
  /** The markdown of the Nth assistant turn from the end (0 = last), through its copy button. */
  | { type: 'dev:copy'; fromEnd: number }
  /** Focus and click the page's pre-render message box: does the real editor mount on interaction? */
  | { type: 'dev:poke' }
  /** Attach a small test picture to the composer: does this chat take pasted images? */
  | { type: 'dev:image' }
  /** Read-only: how many elements match a selector, and the start of the first ones' HTML. */
  | { type: 'dev:probe'; selector: string }
  /** The latest answer's text, as the terminal gets it (development). */
  | { type: 'dev:answer' }
  /** Click the first element matching a selector (development: e.g. remove a test attachment). */
  | { type: 'dev:click'; selector: string };

/** What a chat page looks like to the bridge, for the dev control channel. */
export interface PageDump {
  url: string;
  /** Whether the page is on screen: some chats only mount their composer when it is. */
  visibility: string;
  conversation: string | null;
  composer: string | null;
  /** What in the page looks like a message box: for when the driver's selector finds none. */
  composerCandidates: string[];
  badge: string | null;
  /** The last assistant turns, oldest first, as text, with whether each finished streaming. */
  turns: { done: boolean; text: string }[];
  calls: { kind: string; id: string | null; tool: string | null; error?: string }[];
  /** Raw text of every code element in the last assistant turn, and each one's HTML. */
  blocks: string[];
  blockHtml: string[];
}

/** One command on the dev control channel, and its reply. */
export type DevCommand =
  | { action: 'state' }
  | { action: 'popup'; request: PopupRequest }
  | { action: 'open'; url: string }
  | { action: 'reload-tab'; tabId: number }
  | { action: 'tab'; tabId: number; command: TabCommand };

export const DEV_CALL = 'dev:call';

export interface WhoAmI {
  host: string;
  driver: string;
  conversation: string | null;
}

export type CallsResponse = ToolsCallReply | { error: string };
export type PictureResponse = { dataUrl: string } | { error: string };
/** `elsewhere`: another tab shows this conversation and acts for it — this one only says so. */
/** `terminals`: the `bushwhack` terminals following this chat, and where its approvals go. */
export type StatusResponse = { bound: string | null; autoSend: boolean; elsewhere?: true; terminals?: { count: number; approvals: 'here' | 'terminal' | 'browser' } };

export interface Settings {
  autoSend: boolean;
}

/**
 * Until the operator changes them. Results are sent by themselves: the chat goes on without
 * a click per round, and a result never waits unseen in the message box. Unticked, they
 * wait there for the operator to send.
 */
export const DEFAULT_SETTINGS: Settings = { autoSend: true };
