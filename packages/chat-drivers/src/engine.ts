/**
 * The one piece of DOM code, shared by every chat: read calls out of the page, write an
 * answer back into its composer.
 *
 * Writing is the part that matters and the part that is easy to get wrong. Two rules:
 * the answer goes into the COMPOSER, never into the transcript — a node injected into the
 * transcript is invisible to the model, whose context only holds what was actually sent —
 * and the text goes in the way the page's own editor expects, or its framework
 * re-renders it away.
 */
import { END_LINE, extractFencedBlocks, scanCall, type Call } from '@bushwhack/protocol';
import type { DriverSpec } from './spec.js';

export type FoundCall =
  | { kind: 'call'; call: Call; text: string }
  | { kind: 'invalid'; id: string | null; error: string; text: string; refused?: true };

/**
 * `finished`: the chat says this turn is written. A call without its end line is then no
 * longer one being written: its fence closed early — a body holding a line of three
 * backticks does that — and the model hears so, instead of waiting for a result forever.
 * Where a chat does not say (no `assistantTurnDone`), such a block is left alone: the next
 * pass may find it whole.
 */
function found(text: string, finished: boolean): FoundCall | undefined {
  const scanned = scanCall(text);
  if (!scanned) return undefined;
  if (scanned.kind === 'incomplete') {
    if (!finished) return undefined;
    return {
      kind: 'invalid',
      id: /^id:\s*(\S+)/m.exec(text)?.[1] ?? null,
      error: `this call has no ${END_LINE} line — its block ended early. If its body holds a line of three backticks, fence the call with four or more`,
      text,
    };
  }
  return scanned.kind === 'call' ? { kind: 'call', call: scanned.call, text } : { ...scanned, text };
}

/** Assistant turns the chat has finished streaming, in page order. */
export function finishedTurns(root: ParentNode, spec: DriverSpec): Element[] {
  return [...root.querySelectorAll(spec.transcript.assistantTurn)].filter(
    (turn) => !spec.transcript.assistantTurnDone || turn.matches(spec.transcript.assistantTurnDone),
  );
}

/** Whether a turn may hold a call at all: a cheap look before reading it properly. */
export function mayHoldCalls(turn: Element): boolean {
  return (turn.textContent ?? '').includes('bushwhack:');
}

/** The calls in one turn, read from its rendered code blocks. */
export function callsInTurn(turn: Element, spec: DriverSpec): FoundCall[] {
  // Only a chat that says when a turn is written can tell a cut block from one still coming.
  const finished = spec.transcript.assistantTurnDone !== undefined;
  return [...turn.querySelectorAll(spec.transcript.blocks)].flatMap((element) => found(blockText(element, spec), finished) ?? []);
}

/**
 * The calls in a turn's markdown — what the chat's copy button gives. This is the better
 * source: rendered code loses lines to highlighters and collapsed views (meta.ai drops a
 * `=======` line), the markdown is what the model wrote.
 */
export function callsInMarkdown(markdown: string): FoundCall[] {
  // The markdown of a turn the chat has finished: its copy button gives no other.
  return extractFencedBlocks(markdown).flatMap((block) => found(block, true) ?? []);
}

/**
 * A copy's calls checked against the same blocks as rendered. A chat's copy can drop what
 * the model wrote — meta.ai's removes `[t1]`-like tokens it takes for citation marks, even
 * in code — and a call run from it would write something else than the model sent, the
 * operator approving a diff already wrong. Where the rendered block of a call (same id)
 * holds characters its copy lacks, the call is not run: the model hears what was lost.
 * The other way round — the render lacking lines (a highlighter's loss) — the copy is right.
 */
export function crossCheck(fromCopy: FoundCall[], fromRender: FoundCall[]): FoundCall[] {
  const rendered = new Map<string, string>();
  for (const f of fromRender) if (f.kind === 'call') rendered.set(f.call.id, f.text);
  return fromCopy.map((f) => {
    if (f.kind !== 'call') return f;
    const shown = rendered.get(f.call.id);
    if (shown === undefined) return f;
    const lost = lostBy(f.text, shown);
    if (!lost) return f;
    return {
      kind: 'invalid',
      id: f.call.id,
      text: f.text,
      // Its text would parse: the daemon must get the refusal, not the text.
      refused: true,
      error: `this call reached me altered: the chat's copy of your answer dropped ${lost} (it is on the page, not in what I get). Nothing was run. Write it another way — a space inside the brackets, like [ t1 ], gets through — with a new id.`,
    };
  });
}

/**
 * What `copy` lacks of `shown`, whitespace aside, when `shown` is `copy` with more
 * characters — e.g. "`[t1]`, `[x1]`" — or undefined when nothing was lost that way.
 */
function lostBy(copy: string, shown: string): string | undefined {
  const a = copy.replace(/\s+/g, '');
  const b = shown.replace(/\s+/g, '');
  if (a === b || b.length <= a.length) return undefined;
  const runs: string[] = [];
  let i = 0;
  let run = '';
  for (const ch of b) {
    if (i < a.length && a[i] === ch) {
      if (run) runs.push(run);
      run = '';
      i++;
    } else run += ch;
  }
  if (run) runs.push(run);
  // Not a subsequence: the two differ otherwise, and neither is plainly right.
  if (i < a.length) return undefined;
  return [...new Set(runs)].slice(0, 5).map((r) => `\`${r}\``).join(', ');
}

/**
 * Every finished call in the page, in page order, read from the rendered DOM. Calls still
 * being written — a turn the chat has not finished streaming, or a block without its end
 * line — are skipped; they will be complete on a later pass.
 *
 * Validation stops at the grammar: whether the tool exists and its arguments are right is
 * the daemon's call, not the page's.
 */
export function findCalls(root: ParentNode, spec: DriverSpec): FoundCall[] {
  return finishedTurns(root, spec).flatMap((turn) => callsInTurn(turn, spec));
}

/**
 * A code block's text, newlines included. Highlighters that render one element per line
 * carry no newline characters between them; the driver names the line element and the
 * lines are joined back. Without that, `textContent` is the text as written.
 */
export function blockText(element: Element, spec: DriverSpec): string {
  const selector = spec.transcript.lines;
  if (selector) {
    const lines = element.querySelectorAll(selector);
    // A line element may carry its own newline (meta.ai renders an empty line as "\n"):
    // drop it before joining, or every blank line comes out doubled.
    if (lines.length > 0) return [...lines].map((line) => (line.textContent ?? '').replace(/\n$/, '')).join('\n');
  }
  return element.textContent ?? '';
}

function composerOf(root: ParentNode, spec: DriverSpec): HTMLElement | undefined {
  const element = root.querySelector(spec.composer.selector);
  return element instanceof HTMLElement ? element : undefined;
}

/** What the composer holds now, as the operator sees it. */
export function readComposer(root: ParentNode, spec: DriverSpec): string | undefined {
  const element = composerOf(root, spec);
  if (!element) return undefined;
  const text = element instanceof HTMLTextAreaElement ? element.value : element.innerText ?? element.textContent ?? '';
  return text.replace(/\n$/, '');
}

function setTextarea(textarea: HTMLTextAreaElement, text: string): void {
  // React installs its own `value` setter; a plain assignment leaves its state stale.
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea) as object, 'value')?.set;
  if (setter) setter.call(textarea, text);
  else textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function pasteInto(editor: HTMLElement, text: string): void {
  const view = editor.ownerDocument.defaultView;
  if (!view) return;
  editor.focus();
  // Select what is there, so the paste replaces it; a rich editor tracks the DOM selection
  // through `selectionchange`, and deletes a selection on `beforeinput`.
  const range = editor.ownerDocument.createRange();
  range.selectNodeContents(editor);
  const selection = view.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  editor.ownerDocument.dispatchEvent(new Event('selectionchange'));
  editor.dispatchEvent(new view.InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));

  const data = new view.DataTransfer();
  data.setData('text/plain', text);
  editor.dispatchEvent(new view.ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}

function insertInto(editor: HTMLElement, text: string): void {
  const view = editor.ownerDocument.defaultView;
  if (!view) return;
  editor.focus();
  const selection = view.getSelection();
  selection?.selectAllChildren(editor);
  // Replaces the selection, as typing would; an empty text clears the box.
  if (text === '') editor.ownerDocument.execCommand('delete', false);
  else editor.ownerDocument.execCommand('insertText', false, text);
}

/** Put `text` in the page's composer, replacing what it held. False when there is no composer. */
export function writeToComposer(root: ParentNode, spec: DriverSpec, text: string): boolean {
  const element = composerOf(root, spec);
  if (!element) return false;
  if (spec.composer.kind === 'textarea') setTextarea(element as HTMLTextAreaElement, text);
  else if (spec.composer.kind === 'insertText') insertInto(element, text);
  else pasteInto(element, text);
  return true;
}

function fileOf(dataUrl: string, name: string, view: Window & typeof globalThis): File | undefined {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/.exec(dataUrl);
  if (!match) return undefined;
  const bytes = Uint8Array.from(view.atob(match[2]), (c) => c.charCodeAt(0));
  return new view.File([bytes], `${name}.${match[1].slice('image/'.length)}`, { type: match[1] });
}

/**
 * Attach pictures to the message being written: a paste of image files, after the text,
 * which the chat uploads as it does a picture the operator pastes. False when the driver
 * does not take pictures, or there is no composer.
 */
export function attachImages(root: ParentNode, spec: DriverSpec, images: { name: string; dataUrl: string }[]): boolean {
  const element = composerOf(root, spec);
  const view = element?.ownerDocument.defaultView as (Window & typeof globalThis) | null | undefined;
  if (!element || !view || !spec.composer.images) return false;
  const data = new view.DataTransfer();
  for (const image of images) {
    const file = fileOf(image.dataUrl, image.name, view);
    if (file) data.items.add(file);
  }
  if (data.files.length === 0) return false;
  element.focus();
  // At the end of the text, not over it: the text is already in.
  const selection = view.getSelection();
  selection?.selectAllChildren(element);
  selection?.collapseToEnd();
  element.dispatchEvent(new view.ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  return true;
}

/**
 * Send what the composer holds, when the driver says how. Returns false when sending is
 * the operator's move — a valid driver, not a failure — or when the button is not ready.
 */
export function send(root: ParentNode, spec: DriverSpec): boolean {
  if (!spec.send) return false;

  if (spec.send.button) {
    const button = root.querySelector(spec.send.button);
    if (button instanceof HTMLElement && !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true') {
      button.click();
      return true;
    }
  }

  if (spec.send.enterKey) {
    const composer = composerOf(root, spec);
    if (composer) {
      const init = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 };
      composer.dispatchEvent(new KeyboardEvent('keydown', init));
      composer.dispatchEvent(new KeyboardEvent('keyup', init));
      return true;
    }
  }

  return false;
}
