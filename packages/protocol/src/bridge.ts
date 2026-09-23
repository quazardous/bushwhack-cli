import type { ChatPrompt } from './manifest.js';

/**
 * The bridge between the extension (or the CLI) and a session daemon: where to find it,
 * and the two envelopes it answers. The chat never sees any of this — it only sees calls
 * and results.
 */

/** Daemons bind the first free port in this loopback range; the extension probes it. */
export const PORT_RANGE = { first: 47300, count: 20 } as const;

export function rangePorts(): number[] {
  return Array.from({ length: PORT_RANGE.count }, (_, i) => PORT_RANGE.first + i);
}

/** What `/health` says about a session, beyond the relay's own fields. */
export interface SessionHealth {
  service: 'bushwhack';
  /** One session (`bushwhack serve`)… */
  session?: string;
  folder?: string;
  nodeId?: string;
  /** … or every project of the service (`bushwhack daemon`), one relay and one pairing for all. */
  sessions?: { session: string; folder: string; nodeId: string }[];
}

export const BRIDGE = {
  /** → ToolsListRequest ← ToolsListReply */
  list: 'tools:list',
  /** → ToolsCallRequest ← ToolsCallReply */
  call: 'tools:call',
  /** Every reply carries this type, paired to its request by `replyToId`. */
  reply: 'tools:reply',
} as const;

export interface ToolsListRequest {
  /** The driver's prompt for the chat the manifest is going into. From the extension's own drivers, never from the page. */
  chat?: ChatPrompt;
}

export interface ToolsListReply {
  manifest: string;
  tools: string[];
}

export interface ToolsCallRequest {
  /**
   * Which conversation the calls come from (`<host>/<conversation id>`). Call ids are
   * unique per conversation, so this is half of the replay key.
   */
  conversation: string;
  /** The raw text of each call block, in page order. The daemon parses; it trusts nothing. */
  calls: string[];
  /**
   * The pictures the chat generated in this conversation, the latest first — sent along
   * only when a call is `image:save`, which picks one of them.
   */
  pictures?: Picture[];
}

/** A picture read off the chat's page: its bytes as a data: URL, and its size as shown. */
export interface Picture {
  dataUrl: string;
  width?: number;
  height?: number;
}

export interface ToolsCallReply {
  /** The results, formatted for the chat: what goes into the composer, as is. */
  text: string;
  /** One line per call, for the extension's own display; `error`: what went wrong, in short. */
  summary: { id: string | null; tool: string; status: string; replay: boolean; error?: string }[];
  /** Pictures that go with the results (page:screenshot), as data: URLs, by call id. */
  images?: { id: string | null; image: string }[];
}

export interface BridgeError {
  error: string;
}

/** Normalize a typed pairing code: case, spaces and dashes do not matter. */
export function normalizePairingCode(code: string): string {
  const clean = code.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return clean.match(/.{1,4}/g)?.join('-') ?? '';
}

/** The envelope a paired client sends to make the extension reload itself (development). */
export const EXTENSION_RELOAD = 'ext:reload';
/** Extension nodes register as `ext:<random>`, so `ext:*` reaches every one on a relay. */
export const EXTENSION_NODE_PREFIX = 'ext:';

/**
 * The terminal chat: prompts typed in `bushwhack` go to the chat page bound to the
 * project, and what the page shows comes back. Only the service sends (`chat:send`, for a
 * terminal that proved it is the operator's); only an extension reports (`chat:event`).
 */
export const CHAT = {
  /** service → extension: write this prompt in the project's chat, and send it. */
  send: 'chat:send',
  /** extension → service → terminals: what happens in the chat. */
  event: 'chat:event',
  /** extension → service, every few seconds: "I have a chat of this project open". */
  here: 'chat:here',
  reply: 'chat:reply',
} as const;

export interface ChatSendRequest {
  /** The session's node id: which project's chat. */
  session: string;
  text: string;
  /** Send the tools manifest instead of `text`: the extension makes it for the chat's own driver. */
  manifest?: boolean;
}

export interface ChatEvent {
  session: string;
  conversation?: string;
  /**
   * `answer`: the model's latest answer as the page shows it (`done` once written);
   * `calls`: calls found in it; `results`: their outcome; `notice`: a line to show;
   * `chat`: the chat the project's prompts go to now (from the service: bound, moved), in
   * `text` — without it, no chat holds the project any more.
   */
  kind: 'answer' | 'calls' | 'results' | 'notice' | 'chat';
  text?: string;
  done?: boolean;
  items?: { id: string | null; tool: string; detail?: string; status?: string }[];
}
