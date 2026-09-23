/**
 * Gemini (gemini.google.com). Observed on the live page, 2026-09-22 (French UI, Angular):
 *
 * - An answer is a `model-response`; its markdown container carries `aria-busy`, "true"
 *   while it streams and "false" once written.
 * - Code blocks are `code-block pre > code[data-test-id="code-content"]`, highlighted with
 *   hljs spans but with real newlines and tabs in the text: the DOM reads byte-exact (a
 *   `=======` line and a tab-indented line came through intact). No copy button needed —
 *   Gemini has one per block, none per answer.
 * - The composer is a Quill editor (`.ql-editor[contenteditable]`) that ignores a
 *   synthetic paste of text; `insertText` reaches it, one paragraph per line. A pasted
 *   image file becomes an attachment (removable, "fermer la pièce jointe").
 * - The send button lives in `[data-test-id="send-button-container"]`, as a
 *   `gem-icon-button.submit`; its label is localized, hence the structure.
 * - Conversations live at `/app/<hex id>`. Signed out, a conversation link falls back to
 *   `/app`, empty.
 */
export const GEMINI = {
  id: 'gemini',
  title: 'Gemini',
  hosts: ['gemini.google.com'],
  conversation: '^/app/([0-9a-f]{8,32})',
  transcript: {
    assistantTurn: 'model-response',
    assistantTurnDone: 'model-response:has(message-content [aria-busy="false"])',
    blocks: 'code-block pre > code',
    // A generated picture: a blob: image in its own element (1024×559, 2026-09-22).
    image: 'generated-image img',
    // The chip Gemini puts in an answer that cites an attachment ("JPEG"): not the answer.
    chrome: '.source-inline-chip-container',
  },
  composer: { selector: '.ql-editor[contenteditable="true"]', kind: 'insertText', images: true },
  send: { button: '[data-test-id="send-button-container"] gem-icon-button.submit:not([aria-disabled="true"]) button' },
  // First version, before the model has been watched using the tools: the notes are the
  // ones the call format needs everywhere. Each later note says which mistake it answers.
  prompt: {
    preamble:
      'You are Gemini, in the gemini.google.com web chat. A browser extension reads your answers once they have ' +
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
