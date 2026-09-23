// @vitest-environment jsdom
/**
 * Gemini's page in miniature, shaped like the live one (2026-09-22): a call is read only
 * once its answer has finished streaming, byte-exact through the highlighting, and text
 * reaches the Quill composer through the editing command.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { blockText, findCalls, readComposer, send, writeToComposer } from '../engine.js';
import { conversationId, selectDriver } from '../spec.js';
import { DRIVERS } from '../index.js';

const GEMINI = selectDriver(DRIVERS, 'gemini.google.com')!;

/** The highlighted block Gemini rendered for a call, and a second one with a tab and a `=======` line. */
function answer(busy: boolean): string {
  return `<model-response><message-content><div class="markdown" aria-busy="${busy}">
    <code-block><div class="code-block"><pre><code role="text" data-test-id="code-content">---
bushwhack: fs:read
id: g1
path: README.md
---end
</code></pre></div></code-block>
    <p>Then:</p>
    <code-block><div class="code-block"><pre><code data-test-id="code-content"><span class="hljs-keyword">function</span> add() {}
=======
\t<span class="hljs-comment">// tab</span>
</code></pre></div></code-block>
  </div></message-content></model-response>`;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the Gemini driver', () => {
  it('is picked for gemini.google.com and reads the conversation id', () => {
    expect(GEMINI.id).toBe('gemini');
    expect(conversationId(GEMINI, '/app/eeae00e455a6844b')).toBe('eeae00e455a6844b');
    expect(conversationId(GEMINI, '/app')).toBeUndefined();
  });

  it('reads no call while the answer streams, and the call once it is written', () => {
    document.body.innerHTML = `<user-query><pre><code>---\nbushwhack: fs:read\nid: u1\npath: x\n---end</code></pre></user-query>${answer(true)}`;
    expect(findCalls(document, GEMINI)).toEqual([]);
    document.body.innerHTML = answer(false);
    const calls = findCalls(document, GEMINI);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'call', call: { id: 'g1', tool: 'fs:read' } });
  });

  it('reads a highlighted block byte-exact: its lines, a tab and a `=======` line', () => {
    document.body.innerHTML = answer(false);
    const blocks = [...document.querySelectorAll(GEMINI.transcript.blocks)].map((b) => blockText(b, GEMINI));
    expect(blocks[1]).toBe('function add() {}\n=======\n\t// tab\n');
  });

  it('writes into the Quill composer through insertText, and sends with the submit button', () => {
    document.body.innerHTML = `<div class="ql-editor" contenteditable="true"><p>draft</p></div>
      <div data-test-id="send-button-container"><gem-icon-button class="submit" aria-disabled="false"><button></button></gem-icon-button></div>`;
    const inserted: string[] = [];
    // jsdom has no editing commands: stand in for the browser's.
    document.execCommand = ((command: string, _ui?: boolean, value?: string) => {
      const editor = document.querySelector('.ql-editor')!;
      if (command === 'insertText') {
        inserted.push(value ?? '');
        editor.textContent = value ?? '';
      }
      return true;
    }) as typeof document.execCommand;
    expect(writeToComposer(document, GEMINI, 'line 1\nline 2')).toBe(true);
    expect(inserted).toEqual(['line 1\nline 2']);
    expect(readComposer(document, GEMINI)).toBe('line 1\nline 2');
    let clicked = 0;
    document.querySelector('button')!.addEventListener('click', () => clicked++);
    expect(send(document, GEMINI)).toBe(true);
    expect(clicked).toBe(1);
  });

  it('does not press a disabled send button', () => {
    document.body.innerHTML = `<div data-test-id="send-button-container"><gem-icon-button class="submit" aria-disabled="true"><button></button></gem-icon-button></div>`;
    expect(send(document, GEMINI)).toBe(false);
  });
});
