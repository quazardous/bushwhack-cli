// @vitest-environment jsdom
/**
 * ChatGPT's page in miniature, shaped like the live one (2026-09-22): a turn's calls are
 * read once its action bar — the copy button — is there, from nested code blocks whose
 * header ("bushwhack", a copy button of its own) sits outside the code; text reaches the
 * ProseMirror composer through the editing command, not a paste, which ChatGPT turns into
 * an attached file past a few thousand characters.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { findCalls, readComposer, send, writeToComposer } from '../engine.js';
import { conversationId, selectDriver } from '../spec.js';
import { DRIVERS } from '../index.js';

const CHATGPT = selectDriver(DRIVERS, 'chatgpt.com')!;

/** An assistant turn holding one call, with its action bar once `done`. */
function turn(done: boolean): string {
  return `<section data-testid="conversation-turn-4"><div data-message-author-role="assistant">
    <pre><div><div>bushwhack</div><button aria-label="Copier"></button></div>
      <div id="code-block-viewer"><pre><code><span>---
bushwhack: fs:write
id: c3
path: src/hello.js
---
export function greet(name) {
  // Build a friendly greeting.
  const message = \`Hello, \${name}!\`;
  return message;
}
---end</span></code></pre></div></pre>
  </div>${done ? '<button data-testid="copy-turn-action-button"></button>' : ''}</section>`;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the ChatGPT driver', () => {
  it('is picked for chatgpt.com and reads the conversation id, in a project too', () => {
    expect(CHATGPT.id).toBe('chatgpt');
    expect(selectDriver(DRIVERS, 'chat.openai.com')?.id).toBe('chatgpt');
    expect(conversationId(CHATGPT, '/c/6ab2e57c-fe04-83eb-8d0f-8202a7240c6b')).toBe('6ab2e57c-fe04-83eb-8d0f-8202a7240c6b');
    expect(conversationId(CHATGPT, '/g/g-p-abc/c/6ab2e57c-fe04-83eb-8d0f-8202a7240c6b')).toBe('6ab2e57c-fe04-83eb-8d0f-8202a7240c6b');
    expect(conversationId(CHATGPT, '/')).toBeUndefined();
    // page:screenshot: a pasted image becomes an attachment.
    expect(CHATGPT.composer.images).toBe(true);
  });

  it('reads no call before the turn has its action bar, and the call byte-exact once it has', () => {
    // A call in the user's own turn (the manifest's examples) is never read.
    const mine = '<section data-testid="conversation-turn-3"><div data-message-author-role="user"><pre><code>---\nbushwhack: fs:read\nid: u1\npath: x\n---end</code></pre></div></section>';
    document.body.innerHTML = mine + turn(false);
    expect(findCalls(document, CHATGPT)).toEqual([]);
    document.body.innerHTML = mine + turn(true);
    const calls = findCalls(document, CHATGPT);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'call', call: { id: 'c3', tool: 'fs:write', args: { path: 'src/hello.js' } } });
    expect(calls[0].kind === 'call' && calls[0].call.body).toBe(
      "export function greet(name) {\n  // Build a friendly greeting.\n  const message = `Hello, ${name}!`;\n  return message;\n}",
    );
  });

  it('leaves out of the answer what sits beside it in the turn: the action bar, an ad', () => {
    document.body.innerHTML = `<section data-testid="conversation-turn-6"><div data-conversation-screenshot-content="">
      <div><div data-message-author-role="assistant"><p>The page is green.</p></div></div>
      <div><div role="group"><button data-testid="copy-turn-action-button"></button></div></div>
      <div><div role="link">SEO Agency in your phone</div><div>Pub</div></div>
    </div></section>`;
    const turnEl = document.querySelector(CHATGPT.transcript.assistantTurn)!;
    const left = [...turnEl.querySelectorAll(CHATGPT.transcript.chrome!)].map((e) => e.textContent?.trim());
    expect(left).toContain('SEO Agency in your phonePub');
    expect(left.some((t) => t?.includes('The page is green'))).toBe(false);
  });

  it('tells a finished answer left blank on screen from one that shows', () => {
    document.body.innerHTML = `<section data-testid="conversation-turn-8"><div data-message-author-role="assistant"><div class="empty:hidden"></div></div>
      <button data-testid="copy-turn-action-button"></button></section>`;
    const blank = document.querySelector(CHATGPT.transcript.assistantTurn)!;
    expect(blank.matches(CHATGPT.transcript.stale!)).toBe(true);
    document.body.innerHTML = turn(true);
    expect(document.querySelector(CHATGPT.transcript.assistantTurn)!.matches(CHATGPT.transcript.stale!)).toBe(false);
    // Blank without its action bar too: left so for minutes, it showed on reload. While the
    // chat still writes, its stop button says so, and nothing is stale.
    document.body.innerHTML = turn(false).replace(/<pre>[\s\S]*<\/pre>/, '');
    expect(document.querySelector(CHATGPT.transcript.assistantTurn)!.matches(CHATGPT.transcript.stale!)).toBe(true);
    document.body.insertAdjacentHTML('beforeend', '<button data-testid="stop-button"></button>');
    expect(document.querySelector(CHATGPT.transcript.busy!)).not.toBeNull();
  });

  it('writes into the composer through insertText, and sends with the send button', () => {
    document.body.innerHTML = `<div id="prompt-textarea" contenteditable="true"><p></p></div>
      <button data-testid="send-button" id="composer-submit-button"></button>`;
    const inserted: string[] = [];
    // jsdom has no editing commands: stand in for the browser's.
    document.execCommand = ((command: string, _ui?: boolean, value?: string) => {
      if (command === 'insertText') {
        inserted.push(value ?? '');
        document.querySelector('#prompt-textarea')!.textContent = value ?? '';
      }
      return true;
    }) as typeof document.execCommand;
    expect(writeToComposer(document, CHATGPT, 'line 1\nline 2')).toBe(true);
    expect(inserted).toEqual(['line 1\nline 2']);
    expect(readComposer(document, CHATGPT)).toBe('line 1\nline 2');
    let clicked = 0;
    document.querySelector('button')!.addEventListener('click', () => clicked++);
    expect(send(document, CHATGPT)).toBe(true);
    expect(clicked).toBe(1);
  });
});
