/**
 * A chat driver is a description, not a program.
 *
 * Same reason blocks are data: what changes when a chat UI ships a redesign is a handful
 * of selectors, and a selector set can be reviewed, diffed and swapped without rebuilding
 * the extension. The engine in `engine.ts` is the only code, and it is the same for every
 * chat.
 */
import { z } from 'zod';
import { CHAT_PROMPT_LIMITS, type ChatPrompt } from '@bushwhack/protocol';

export const DriverSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    title: z.string().min(1).max(80),
    /** Hostnames this driver claims, matched exactly or as a `.suffix`. */
    hosts: z.array(z.string().min(3).max(120)).min(1),
    /**
     * Where the chat serves its generated pictures from, when the page itself may not read
     * them (no CORS): the extension fetches them there instead. Matched as a `.suffix`.
     */
    imageHosts: z.array(z.string().min(3).max(120)).optional(),
    /**
     * Where the conversation id is in the URL: a regex on `location.pathname` whose first
     * group is the id. A page without one (a fresh chat) is not a conversation yet, and
     * nothing is read from it.
     */
    conversation: z.string().min(1),
    transcript: z
      .object({
        /** One assistant turn. */
        assistantTurn: z.string().min(1),
        /**
         * Matched by an assistant turn once the chat has finished streaming it. Optional
         * because the grammar's end line already guards against half-written calls; when
         * the UI says it is done, reading nothing earlier is cheaper and quieter.
         */
        assistantTurnDone: z.string().min(1).optional(),
        /** Code blocks inside a turn. Their text is scanned; anything that is not a call is skipped. */
        blocks: z.string().min(1),
        /**
         * One element per line inside a block, when the chat highlights code that way. A
         * highlighter that renders each line as its own element drops the newlines, so
         * `textContent` glues the lines together; with this selector the engine joins
         * them back. Omit for chats whose code keeps its newline characters.
         */
        lines: z.string().min(1).optional(),
        /**
         * The turn's own "copy" button, relative to the turn. When the chat has one, the
         * answer is read as the markdown the model wrote — the clipboard write is captured
         * in the page, the clipboard itself is left alone — instead of from the rendered
         * DOM, which highlighters and collapsed views rewrite.
         */
        copy: z.string().min(1).optional(),
        /**
         * What a turn shows that is not the answer — a "show the reasoning" toggle, the
         * steps of a search — left out when the answer's text is read for the terminal.
         */
        chrome: z.string().min(1).optional(),
        /**
         * A finished answer the chat left blank on screen (its message never rendered). Seen
         * long enough, the page is reloaded once so the answer — and its calls — can be read.
         */
        stale: z.string().min(1).optional(),
        /**
         * A picture the model generated, inside a turn — not an avatar, not an icon. What
         * image:save saves: the extension reads it off the page when a call asks for it.
         */
        image: z.string().min(1).optional(),
        /** Anywhere in the page while the chat is still writing — no answer is stale then. */
        busy: z.string().min(1).optional(),
      })
      .strict(),
    composer: z
      .object({
        selector: z.string().min(1),
        /**
         * How text gets in so that the page's framework registers it:
         * - `textarea`: the native value setter plus an `input` event (React);
         * - `paste`: a synthetic paste of `text/plain` — what rich editors (Lexical,
         *   ProseMirror) handle byte-exact, where setting `textContent` is wiped on the
         *   next render;
         * - `insertText`: the editing command a person's typing goes through
         *   (`execCommand('insertText')`), for editors that ignore a synthetic paste (Quill).
         */
        kind: z.enum(['textarea', 'paste', 'insertText']),
        /** Whether a pasted image file becomes an attachment (page:screenshot). */
        images: z.boolean().optional(),
        /**
         * What an attached picture looks like once the chat took it, anywhere in the page.
         * With it, a picture the chat refused (a quota, a size) is caught before sending,
         * and the model is told it is not there instead of describing what it never saw.
         */
        attachment: z.string().min(1).optional(),
      })
      .strict(),
    /**
     * What the model is told about this chat, on top of the tools: see `ChatPrompt` in
     * @bushwhack/protocol. Every note here was earned by watching the model get it wrong.
     */
    prompt: z
      .object({
        preamble: z.string().min(1).max(CHAT_PROMPT_LIMITS.preamble),
        notes: z.array(z.string().min(1).max(CHAT_PROMPT_LIMITS.note)).max(CHAT_PROMPT_LIMITS.notes),
      })
      .strict(),
    /** How to send. Omit to leave sending to the operator. */
    send: z
      .object({
        button: z.string().min(1).optional(),
        /** Enter with no modifier, as most chats do. */
        enterKey: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DriverSpec = z.infer<typeof DriverSpecSchema>;

export class DriverSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverSpecError';
  }
}

export function parseDriverSpec(raw: unknown): DriverSpec {
  const parsed = DriverSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DriverSpecError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  try {
    new RegExp(parsed.data.conversation);
  } catch {
    throw new DriverSpecError(`conversation: not a regex: ${parsed.data.conversation}`);
  }
  return parsed.data;
}

/** The driver for a hostname, or undefined when no driver claims it. */
export function selectDriver(specs: DriverSpec[], hostname: string): DriverSpec | undefined {
  return specs.find((spec) =>
    spec.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`)),
  );
}

/** The conversation id in a pathname, or undefined when the page is not a conversation yet. */
export function conversationId(spec: DriverSpec, pathname: string): string | undefined {
  return new RegExp(spec.conversation).exec(pathname)?.[1] || undefined;
}

/** The driver's prompt, in the shape the manifest takes. */
export function chatPrompt(spec: DriverSpec): ChatPrompt {
  return { title: spec.title, preamble: spec.prompt.preamble, notes: spec.prompt.notes };
}
