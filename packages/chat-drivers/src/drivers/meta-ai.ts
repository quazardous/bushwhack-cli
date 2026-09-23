/**
 * meta.ai, read off the live page on 2026-09-22 (Chromium 153, French UI — no selector
 * below depends on the language).
 *
 * - Assistant turns carry `data-testid="assistant-message"` and, once streamed,
 *   `data-streaming-complete="true"` (with `data-streaming-state="DONE"`).
 * - Code blocks render as `pre > code`. While streaming, the code is plain text; once
 *   highlighted (Shiki, "streamdown"), each line becomes `code > span.block` with no
 *   newline between them — `textContent` then glues the lines together. Observed
 *   2026-09-22 on the first real call: read once plain, then unreadable.
 * - The composer is a Lexical editor, `div[contenteditable][data-testid="composer-input"]`.
 *   A hidden prehydration `textarea` shares the test id, hence the `contenteditable`
 *   qualifier. Setting `textContent` does not reach Lexical's state; a paste does, exactly.
 * - A pasted image file becomes an inline attachment (with a "Remove image" button), as a
 *   picture the operator pastes: that is how page:screenshot reaches the model.
 * - The send button is `data-testid="composer-send-button"`, disabled while empty.
 * - Conversations live at `/prompt/<uuid>`.
 */
export const META_AI = {
  id: 'meta-ai',
  title: 'Meta AI',
  hosts: ['meta.ai'],
  // Imagine's pictures from fbcdn.net (readable by the page), a resized one from
  // cdn.fbsbx.com (not: no CORS) — 2026-09-23.
  imageHosts: ['fbcdn.net', 'fbsbx.com'],
  conversation: '^/prompt/([0-9a-f-]{36})',
  transcript: {
    assistantTurn: '[data-testid="assistant-message"]',
    assistantTurnDone: '[data-streaming-complete="true"]',
    blocks: 'pre > code',
    // Imagine's pictures come from its CDN (1600×1600 WebP, 2026-09-23); the reasoning logo
    // beside an answer comes from meta.ai itself.
    image: 'img[src*="fbcdn.net"], img[src*="fbsbx.com"]',
    lines: ':scope > span',
    // Above an answer: the reasoning toggle ("Afficher la réflexion") and the steps it
    // took ("Recherche de configuration serveur") — not the answer. Under it, the follow-ups
    // meta.ai offers ("Génère la même icône en blanc…"), and in a long code block its
    // "N lignes masquées" expander: buttons shaped icon-then-text, with no stable attribute
    // (2026-09-23). The buttons alone go, never what holds them. And over every code block,
    // its header: the "Code" label and its buttons — the code itself stays.
    chrome: '[data-testid="thinking-status"], [data-testid="subagent-cot-list"], button:has(> svg + span:last-child), .ur-code-block__header',
    // Under each answer: like, dislike, copy, share, each in its own div. Labels are
    // localized and the copy button's <canvas> only exists once it has animated, so the
    // button is found by position: the third.
    copy: ':scope > div > div > div > [data-slot="flexbox"] > div > div:nth-child(3) > button',
  },
  composer: { selector: 'div[data-testid="composer-input"][contenteditable="true"]', kind: 'paste', images: true },
  send: { button: 'button[data-testid="composer-send-button"]' },
  // Written from how meta.ai renders and streams. First live session, 2026-09-22: the
  // model followed the call shape from its first answer, one call per block, ending
  // every call with its end line; it batched reads; after errors it retried with new ids
  // and re-read files to check its own edits. No note had to change. When one does, say
  // which mistake the model was seen making.
  prompt: {
    preamble:
      'You are Meta AI, in the meta.ai web chat. A browser extension reads your answers once they have ' +
      'finished streaming; it only looks at code blocks. It runs the calls it finds against my project ' +
      'and puts the results in my message box — I send them to you.',
    notes: [
      'One call per code block, tagged `bushwhack`. Never two calls in one block, never prose inside a block.',
      'Do not indent a call block, and do not put it inside a list or a quote.',
      'After your calls, end your answer. Do not predict what a result will say, and never write a `bushwhack-result` block: the real one comes in my next message.',
      'Very long answers get cut off. To change a long file, prefer several `fs:edit` calls to one `fs:write`; keep one answer under about 200 lines of code.',
      'Before `fs:edit`, `fs:read` the lines you change: SEARCH must match the file exactly, spaces and indentation included.',
      'Talk to me in the language I write in. Tool names, keys and the call shape stay exactly as specified.',
    ],
  },
} as const;
