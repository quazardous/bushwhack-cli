/**
 * The terminal chat: how the chat's events read in a terminal, and a prompt from a script
 * answered with the chat's last answer — not the one before its tool calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubNode, WebSocketTransport } from '@bushwhack/hub';
import { CHAT } from '@bushwhack/protocol';
import { connectBridge } from './bridge-client.js';
import { busyAfter, renderEvent, renderMarkdown, runChatOnce, runChatTerminal, styleFor, whereLines } from './chat-terminal.js';
import type { OctopodClient } from './octopod-client.js';
import { readServiceFile, startService, type Service } from './service.js';

const plain = styleFor(false);

describe('rendering', () => {
  it('draws a call, its result, and a failed one', () => {
    expect(renderEvent({ session: 's', kind: 'calls', items: [{ id: 'c1', tool: 'fs:read', detail: 'src/app.ts' }] }, plain)).toBe('● fs:read(src/app.ts)');
    expect(renderEvent({ session: 's', kind: 'results', items: [{ id: 'c1', tool: 'fs:read', status: 'ok' }, { id: 'c2', tool: 'fs:write', status: 'denied' }] }, plain)).toBe('  ⎿  c1 ok\n  ⎿  c2 denied');
    // An error says why, an invalid call especially: nothing else records it.
    expect(renderEvent({ session: 's', kind: 'results', items: [{ id: 'c3', tool: 'unknown', status: 'error', detail: 'this call has no ---end line' }] }, plain)).toBe('  ⎿  c3 error — this call has no ---end line');
  });

  it('shows an answer once it is written, not while it streams', () => {
    expect(renderEvent({ session: 's', kind: 'answer', text: 'half', done: false }, plain)).toBeUndefined();
    expect(renderEvent({ session: 's', kind: 'answer', text: '# Done\n- one', done: true }, plain)).toBe('Done\n• one');
  });

  it('frames code blocks and keeps their lines as they are', () => {
    expect(renderMarkdown('see:\n```ts\n  const a = 1;\n```', plain)).toBe('see:\n  ┌─ ts \n  │   const a = 1;\n  └─');
  });
});

describe('what the spinner says', () => {
  const s = 'semis';
  it('says what the model is doing, and stops once its answer is done', () => {
    expect(busyAfter({ session: s, kind: 'answer', text: 'Voici' }, 'x')).toBe('the model is writing… 5 characters');
    // An answer of calls only has no text: no "0 characters".
    expect(busyAfter({ session: s, kind: 'answer', text: '' }, 'running 2 calls…')).toBe('running 2 calls…');
    expect(busyAfter({ session: s, kind: 'calls', items: [{ id: 'c1', tool: 'fs:read' }, { id: 'c2', tool: 'fs:read' }] }, undefined)).toBe('running 2 calls…');
    expect(busyAfter({ session: s, kind: 'results', items: [] }, 'running 2 calls…')).toBe('results sent — the model goes on…');
    expect(busyAfter({ session: s, kind: 'answer', text: 'fini', done: true }, 'x')).toBeUndefined();
  });
});

describe('where the terminal is', () => {
  const project = { session: 'shop', folder: '/p/shop', nodeId: 'session:shop-1', app: '' };
  it('names the instance, the browsers, and the one the prompts go to', () => {
    const live = { ...project, chat: { browser: 'Chromium 153', chat: 'Gemini', conversation: 'gemini.google.com/abc' } };
    const lines = whereLines({ instance: 'dev', port: 47301, projects: [live], browsers: [{ node: 'ext:a', browser: 'Google Chrome 140', dev: false, chats: [] }, { node: 'ext:b', browser: 'Chromium 153', dev: true, chats: ['shop', 'blog'] }] }, project, plain);
    expect(lines).toEqual([
      '  instance  dev :47301',
      '  browser   Google Chrome 140',
      "  browser   Chromium 153 (dev extension) ← shop's chat is open here: prompts go here  (also: blog)",
      '  chat      Gemini — gemini.google.com/abc',
      '            keep the browser window in sight: a hidden one runs the chat slowly (Meta AI does not even load its message box)',
    ]);
  });

  it('says so when no browser holds the chat, or none is connected', () => {
    expect(whereLines({ projects: [project], browsers: [{ node: 'ext:a', browser: 'Chromium 153', dev: false, chats: [] }] }, project, plain).at(-1)).toMatch(/no browser has shop's chat open/);
    expect(whereLines({ projects: [project], browsers: [] }, project, plain)[1]).toMatch(/none connected/);
  });
});

describe('a prompt from a script', () => {
  let base: string;
  let service: Service;
  let closers: (() => void)[];

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'bw-chat-'));
    await mkdir(join(base, 'shop'));
    closers = [];
    service = await startService({ dir: join(base, 'service'), ports: [19580, 19581], octopod: { available: async () => false } as unknown as OctopodClient, out: () => {} });
    await service.add(join(base, 'shop'));
  });

  afterEach(async () => {
    for (const c of closers) c();
    await service.close();
    await rm(base, { recursive: true, force: true });
  });

  it('gets the chat\'s last answer, after its calls, not the first one', async () => {
    const project = service.list()[0];
    const ext = new HubNode({ nodeId: 'ext:test', defaultScope: 'global' });
    const t = new WebSocketTransport({ name: 'relay', url: `ws://127.0.0.1:${service.port}`, peerPatterns: ['*'], reconnect: { maxAttempts: 1 }, registrationMessage: { type: 'register', nodeId: 'ext:test', securityKey: service.code, client: 'extension' } });
    ext.addTransport(t);
    await t.connect();
    closers.push(() => t.disconnect());
    const report = (event: object): void => void ext.emit(CHAT.event, { session: project.nodeId, ...event }, { target: 'service:bushwhack' });
    ext.on(CHAT.send, (payload: unknown, envelope) => {
      ext.emit(CHAT.reply, { ok: true, conversation: 'chat/1' }, { target: envelope.source, replyToId: envelope.id });
      // The model reads a file first, then answers.
      setTimeout(() => report({ kind: 'answer', text: 'Let me look.', done: true }), 50);
      // Its call comes inside the wait after the first answer; its real answer, well after.
      setTimeout(() => report({ kind: 'calls', items: [{ id: 'c1', tool: 'fs:read' }] }), 250);
      setTimeout(() => report({ kind: 'results', items: [{ id: 'c1', tool: 'fs:read', status: 'ok' }] }), 450);
      setTimeout(() => report({ kind: 'answer', text: 'It is a shop.', done: true }), 800);
    });
    report({ kind: 'answer' }); // (ignored: not done)
    ext.emit(CHAT.here, { session: project.nodeId }, { target: 'service:bushwhack' });
    await new Promise((r) => setTimeout(r, 100));
    const file = (await readServiceFile(join(base, 'service')))!;
    expect(await runChatOnce(file, project, 'what is this project?', 10_000, 300)).toBe('It is a shop.');
  });

  it('with --yolo, says yes to every approval by itself, and shows what it accepted', async () => {
    const project = service.list()[0];
    const file = (await readServiceFile(join(base, 'service')))!;
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (c) => (shown += String(c)));
    const terminal = runChatTerminal({ file, project, stateDir: join(base, 'shop', '.bushwhack'), yolo: true, input: input as never, output: output as never });
    await new Promise((r) => setTimeout(r, 300));
    const bridge = await connectBridge({ port: service.port, code: service.code, daemonNodeId: project.nodeId, nodeId: 'client-yolo', client: 'test' });
    closers.push(() => bridge.close());
    const reply = await bridge.call({ conversation: 'c', calls: ['---\nbushwhack: fs:write\nid: w1\npath: yolo.txt\n---\nwritten\n---end'] }, 5000);
    expect(reply.text).toContain('status: ok');
    expect(await readFile(join(base, 'shop', 'yolo.txt'), 'utf8')).toBe('written\n');
    expect(shown).toContain('--yolo: every approval for shop is a yes');
    expect(shown).toMatch(/yolo.*shop · w1 fs:write[\s\S]*accepted/);

    // Another project's approval reaching this terminal is asked, not taken.
    await mkdir(join(base, 'blog'));
    const blog = await service.add(join(base, 'blog'));
    const other = await connectBridge({ port: service.port, code: service.code, daemonNodeId: blog.nodeId, nodeId: 'client-yolo-blog', client: 'test' });
    closers.push(() => other.close());
    const asking = other.call({ conversation: 'c', calls: ['---\nbushwhack: fs:write\nid: w1\npath: no.txt\n---\nno\n---end'] }, 5000);
    await new Promise((r) => setTimeout(r, 400));
    expect(shown).toMatch(/blog · w1 fs:write[\s\S]*approve\?/);
    input.write('n\n');
    expect((await asking).summary[0].status).toBe('denied');
    input.end();
    await terminal;
  });
});

describe('an answer with nothing to read', () => {
  it('still ends the wait, and says so', () => {
    const done = { session: 's', kind: 'answer' as const, text: '', done: true };
    expect(busyAfter(done, 'the model is answering…')).toBeUndefined();
    expect(renderEvent(done, plain)).toBe('  ✻ the model answered, with nothing to read');
    // A picture answer comes with a line that says what it holds.
    expect(renderEvent({ ...done, text: '(a picture — image:save puts one in the project)' }, plain)).toContain('a picture');
  });
});

describe('an error in short', () => {
  it('keeps the first line, cut to fit', async () => {
    const { shortError } = await import('./session-node.js');
    expect(shortError('\nno tool "fs:wrte"; the tools are …\nmore')).toBe('no tool "fs:wrte"; the tools are …');
    expect(shortError('x'.repeat(300))).toHaveLength(200);
  });
});
