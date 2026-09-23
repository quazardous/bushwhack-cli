// @vitest-environment jsdom
/**
 * The failure modes worth a test: acting on a call the model has not finished writing,
 * reading calls from the operator's own messages, and writing into a composer in a way
 * its editor ignores.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { callsInMarkdown, findCalls, readComposer, writeToComposer, send } from './engine.js';
import { conversationId, parseDriverSpec, selectDriver } from './spec.js';
import { DRIVERS } from './index.js';

const META = DRIVERS[0];

const TEXTAREA = parseDriverSpec({
  ...META,
  id: 'fixture',
  hosts: ['chat.example'],
  composer: { selector: 'textarea[name="composer"]', kind: 'textarea' },
  send: { button: 'button[data-send]' },
});

const READ = '---\nbushwhack: fs:read\nid: c1\npath: README.md\n---end';

function page(html: string): void {
  document.body.innerHTML = html;
}

function turn(code: string, done = true): string {
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<div data-testid="assistant-message" data-streaming-complete="${done}">
    <div class="ur-code-block"><div class="ur-code-block__content"><pre><code>${escaped}</code></pre></div></div>
  </div>`;
}

// jsdom has no clipboard events; a minimal stand-in with the shape the engine uses.
beforeAll(() => {
  class FakeDataTransfer {
    private data = new Map<string, string>();
    setData(type: string, value: string): void { this.data.set(type, value); }
    getData(type: string): string { return this.data.get(type) ?? ''; }
  }
  class FakeClipboardEvent extends Event {
    readonly clipboardData: FakeDataTransfer | null;
    constructor(type: string, init: EventInit & { clipboardData?: FakeDataTransfer }) {
      super(type, init);
      this.clipboardData = init.clipboardData ?? null;
    }
  }
  Object.assign(window, { DataTransfer: FakeDataTransfer, ClipboardEvent: FakeClipboardEvent });
});

/** A rich editor in miniature: it keeps its own state, and only input events change it. */
function richEditor(): { state: () => string } {
  page('<div data-testid="composer-input" contenteditable="true"></div>');
  const editor = document.querySelector<HTMLElement>('[data-testid="composer-input"]')!;
  let state = 'draft';
  const render = (): void => { editor.textContent = state; };
  render();
  editor.addEventListener('beforeinput', (e) => {
    if ((e as InputEvent).inputType === 'deleteContentBackward') state = '';
    render();
  });
  editor.addEventListener('paste', (e) => {
    state += (e as unknown as { clipboardData: DataTransfer }).clipboardData.getData('text/plain');
    render();
  });
  return { state: () => state };
}

describe('findCalls on meta.ai', () => {
  beforeEach(() => page(''));

  it('finds a finished call', () => {
    page(turn(READ));
    expect(findCalls(document, META)).toEqual([
      { kind: 'call', call: { tool: 'fs:read', id: 'c1', args: { path: 'README.md' }, body: null }, text: READ },
    ]);
  });

  it('waits for the turn to finish streaming, even when the call looks complete', () => {
    page(turn(READ, false));
    expect(findCalls(document, META)).toEqual([]);
  });

  it('tells the model of a call whose block ended early, and leaves one alone when the chat does not say the turn is done', () => {
    page(turn(READ.replace('---end', '')));
    expect(findCalls(document, META)).toMatchObject([{ kind: 'invalid', id: 'c1', error: expect.stringContaining('four or more') }]);
    // A chat that never says a turn is written: the block may still be coming.
    const streaming = { ...META, transcript: { ...META.transcript, assistantTurnDone: undefined } };
    expect(findCalls(document, streaming)).toEqual([]);
  });

  it('never reads a call out of the operator\'s own message', () => {
    page(`<div data-user-message><pre><code>${READ}</code></pre></div>`);
    expect(findCalls(document, META)).toEqual([]);
  });

  it('reports a finished but malformed call, so the model can be told', () => {
    page(turn('---\nbushwhack: fs:read\npath: a\n---end'));
    expect(findCalls(document, META)).toMatchObject([{ kind: 'invalid', id: null, error: 'every call needs an "id"' }]);
  });

  it('reads a call from code highlighted one element per line, with no newlines', () => {
    const spans = READ.split('\n').map((line) => `<span class="block"><span>${line}</span></span>`).join('');
    page(`<div data-testid="assistant-message" data-streaming-complete="true"><pre><code>${spans}</code></pre></div>`);
    expect(findCalls(document, META)).toMatchObject([{ kind: 'call', call: { id: 'c1', tool: 'fs:read' } }]);
  });

  it('keeps one blank line one blank line, when the highlighter writes it as a newline', () => {
    const lines = ['---', 'bushwhack: fs:write', 'id: w1', 'path: a.md', '---', 'x', '', 'y', '---end'];
    const spans = lines.map((line) => (line === '' ? '<span>\n</span>' : `<span><span>${line}</span></span>`)).join('');
    page(`<div data-testid="assistant-message" data-streaming-complete="true"><pre><code>${spans}</code></pre></div>`);
    expect(findCalls(document, META)).toMatchObject([{ kind: 'call', call: { body: 'x\n\ny' } }]);
  });

  it('keeps page order across turns', () => {
    page(turn(READ) + turn(READ.replace('c1', 'c2')));
    expect(findCalls(document, META).map((f) => f.kind === 'call' && f.call.id)).toEqual(['c1', 'c2']);
  });
});

describe('writeToComposer', () => {
  it('pastes into a rich editor, replacing the draft, byte-exact', () => {
    const editor = richEditor();
    const text = '```\n  indented\n\nafter blank\n```';

    expect(writeToComposer(document, META, text)).toBe(true);

    expect(editor.state()).toBe(text);
    expect(readComposer(document, META)).toBe(text);
  });

  it('sets a textarea through the native setter and fires input', () => {
    page('<textarea name="composer"></textarea>');
    const events: string[] = [];
    document.querySelector('textarea')!.addEventListener('input', () => events.push('input'));

    expect(writeToComposer(document, TEXTAREA, 'result: ok')).toBe(true);
    expect(document.querySelector('textarea')!.value).toBe('result: ok');
    expect(events).toEqual(['input']);
  });

  it('reports a composer it cannot find rather than failing silently', () => {
    page('<div>no composer here</div>');
    expect(writeToComposer(document, META, 'x')).toBe(false);
  });

  it('never writes into the transcript', () => {
    page(`${turn(READ)}<div data-testid="composer-input" contenteditable="true"></div>`);
    const before = document.querySelector('[data-testid="assistant-message"]')!.innerHTML;
    writeToComposer(document, META, 'result');
    expect(document.querySelector('[data-testid="assistant-message"]')!.innerHTML).toBe(before);
  });
});

describe('send', () => {
  it('clicks the send button once it is enabled, not before', () => {
    page('<button data-testid="composer-send-button" disabled>send</button>');
    let clicks = 0;
    const button = document.querySelector('button')!;
    button.addEventListener('click', () => clicks++);

    expect(send(document, META)).toBe(false);
    button.removeAttribute('disabled');
    expect(send(document, META)).toBe(true);
    expect(clicks).toBe(1);
  });

  it('leaves sending to the operator when the driver says nothing', () => {
    page('<textarea name="composer"></textarea>');
    expect(send(document, parseDriverSpec({ ...TEXTAREA, send: undefined }))).toBe(false);
  });
});

describe('selectDriver and conversationId', () => {
  it('matches a host and its subdomains, and nothing else', () => {
    expect(selectDriver(DRIVERS, 'www.meta.ai')?.id).toBe('meta-ai');
    expect(selectDriver(DRIVERS, 'evilmeta.ai')).toBeUndefined();
  });

  it('reads the conversation from the path, and nothing from a fresh chat', () => {
    expect(conversationId(META, '/prompt/7bf524b0-7df5-4a6a-8266-13ac63cc514b')).toBe('7bf524b0-7df5-4a6a-8266-13ac63cc514b');
    expect(conversationId(META, '/')).toBeUndefined();
  });
});

describe('callsInMarkdown', () => {
  it('reads calls from the markdown a copy button gives, prose and all', () => {
    const md = 'Je lis.\n\n```bushwhack\n' + READ + '\n```\n\nPuis:\n\n```bushwhack\n' + READ.replace('c1', 'c2') + '\n```';
    expect(callsInMarkdown(md).map((f) => f.kind === 'call' && f.call.id)).toEqual(['c1', 'c2']);
  });

  it('ignores code that is not a call, and tells the model of one whose block ended early', () => {
    expect(callsInMarkdown('```js\nconsole.log(1)\n```')).toEqual([]);
    // A body holding a line of three backticks closes the fence: the call loses its end.
    expect(callsInMarkdown('```\n' + READ.replace('---end', '') + '\n```')).toMatchObject([
      { kind: 'invalid', id: 'c1', error: expect.stringContaining('no ---end line') },
    ]);
  });
});
