/**
 * ChatGPT (chatgpt.com), read off the live page on 2026-09-22 (Chromium 153, French UI —
 * no selector below depends on the language).
 *
 * - Each turn is a `section[data-testid="conversation-turn-N"]`; the answer inside carries
 *   `data-message-author-role="assistant"`.
 * - A turn gets its action bar — copy among them, `data-testid="copy-turn-action-button"`
 *   — once it has finished streaming: its presence says the answer is done, and the copy
 *   gives the markdown the model wrote.
 * - Code blocks nest: an outer `pre` holds the block's header ("bushwhack", a copy button)
 *   and, further down, `pre > code` with the text, newlines kept.
 * - One turn may hold several assistant messages; the turn's copy button covers them all.
 * - On the free plan an answer may be followed, in its turn, by an ad ("Pub"): a block
 *   beside the message, left out of the answer's text.
 * - The composer is a ProseMirror editor, `div#prompt-textarea[contenteditable]`. A paste
 *   of the manifest (several thousand characters) became an attached text file, not text:
 *   the editing command (`insertText`) writes it as text.
 * - A pasted image file becomes an attachment, uploaded at once (a "remove file" button):
 *   that is how page:screenshot reaches the model. Its preview is an `img` in the composer's
 *   form. Once the free plan's quota of files is spent, a pasted picture shows nothing at all.
 * - The send button (`data-testid="send-button"`) only exists while the composer holds text.
 * - A finished answer was sometimes left blank on screen — its message empty, with or
 *   without its action bar, the stop button gone — for minutes, until the page was reloaded:
 *   then it showed, calls and all (three times on 2026-09-22, once with the tab in the
 *   background). Losing focus alone does not do it. `stale` and `busy` describe that state:
 *   the extension reloads the page once to read it.
 * - Conversations live at `/c/<uuid>`, also under a project (`/g/<project>/c/<uuid>`).
 */
const TURN = 'section[data-testid^="conversation-turn"]:has([data-message-author-role="assistant"])';

export const CHATGPT = {
  id: 'chatgpt',
  title: 'ChatGPT',
  hosts: ['chatgpt.com', 'chat.openai.com'],
  conversation: '/c/([0-9a-f-]{36})$',
  transcript: {
    assistantTurn: TURN,
    assistantTurnDone: `${TURN}:has([data-testid="copy-turn-action-button"])`,
    blocks: 'pre code',
    copy: '[data-testid="copy-turn-action-button"]',
    // Beside the answer, in the same turn: its action bar, and on the free plan an ad
    // ("Pub", a sponsor's link) — not the answer.
    chrome: '[data-conversation-screenshot-content] > div:not(:has([data-message-author-role]))',
    // Blank: nothing rendered in its message — stale once the chat has stopped writing.
    stale: `${TURN}:not(:has([data-message-author-role="assistant"] :is(p, pre, li, h1, h2, h3, h4, table, blockquote, img, figure)))`,
    busy: '[data-testid="stop-button"]',
  },
  composer: { selector: '#prompt-textarea[contenteditable="true"]', kind: 'insertText', images: true, attachment: 'form:has(#prompt-textarea) img' },
  send: { button: 'button[data-testid="send-button"]:not([disabled])' },
  // First live session, 2026-09-22: from the manifest alone the model batched fs:list and
  // fs:read, then wrote a multi-line file with a template string, byte-exact, and ended its
  // answer to wait. No note had to change. When one does, say which mistake it answers.
  prompt: {
    preamble:
      'You are ChatGPT, in the chatgpt.com web chat. A browser extension reads your answers once they have ' +
      'finished streaming; it only looks at code blocks. It runs the calls it finds against my project ' +
      'and puts the results in my message box — I send them to you.',
    notes: [
      'One call per code block, tagged `bushwhack`. Never two calls in one block, never prose inside a block.',
      'Put in one answer every call you can decide now — several reads, several writes — as blocks one after the other: each answer costs a round trip. Wait for results only when a call depends on what another returns.',
      'Do not indent a call block, and do not put it inside a list or a quote.',
      'After your calls, end your answer. Do not predict what a result will say, and never write a `bushwhack-result` block: the real one comes in my next message.',
      'Before `fs:edit`, `fs:read` the lines you change: SEARCH must match the file exactly, spaces and indentation included.',
      'Talk to me in the language I write in. Tool names, keys and the call shape stay exactly as specified.',
    ],
  },
} as const;
