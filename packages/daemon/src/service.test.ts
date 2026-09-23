/**
 * The service: several projects on one relay and one pairing, each as isolated as under
 * `serve`, with approvals answered by whoever holds the operator key — and nobody else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubNode, WebSocketTransport } from '@bushwhack/hub';
import { CHAT } from '@bushwhack/protocol';
import { operatorClient } from './service-client.js';
import { connectBridge, type BridgeClient } from './bridge-client.js';
import type { OctopodClient } from './octopod-client.js';
import { readServiceFile, SERVICE, SERVICE_NODE, startService, type Service } from './service.js';

const PORTS = [19560, 19561];
const noOctopod = { available: async () => false } as unknown as OctopodClient;

let base: string;
let dir: string;
let alpha: string;
let beta: string;
let service: Service;
let clients: { close(): void }[];

async function start(approvalWaitMs = 2000): Promise<void> {
  service = await startService({ dir, ports: PORTS, octopod: noOctopod, out: () => {}, env: { XDG_STATE_HOME: join(base, 'xdg') }, approvalWaitMs });
}

async function bridgeTo(folder: string): Promise<BridgeClient> {
  const project = service.list().find((p) => p.folder === folder)!;
  const bridge = await connectBridge({ port: service.port, code: service.code, daemonNodeId: project.nodeId, nodeId: `client-${clients.length}`, client: 'test' });
  clients.push(bridge);
  return bridge;
}

/** An approvals client on the relay: answers with `answer`, signing with `key`. */
async function approvals(key: string, answer: (kind: string, payload: Record<string, unknown>) => Record<string, unknown>, claim = false): Promise<Record<string, unknown>[]> {
  const seen: Record<string, unknown>[] = [];
  const node = new HubNode({ nodeId: `approvals:${clients.length}`, defaultScope: 'global' });
  const transport = new WebSocketTransport({ name: 'relay', url: `ws://127.0.0.1:${service.port}`, peerPatterns: ['*'], reconnect: { maxAttempts: 1 }, registrationMessage: { type: 'register', nodeId: `approvals:${clients.length}`, securityKey: service.code, client: 'approvals' } });
  node.addTransport(transport);
  await transport.connect();
  for (const kind of [SERVICE.approve, SERVICE.secret]) {
    node.on(kind, (payload: unknown, envelope) => {
      seen.push({ kind, ...(payload as Record<string, unknown>) });
      node.emit(SERVICE.approvalReply, { key, ...answer(kind, payload as Record<string, unknown>) }, { target: envelope.source, replyToId: envelope.id });
    });
  }
  clients.push({ close: () => transport.disconnect() });
  if (claim) await node.request(SERVICE.approvalsHere, { key }, { target: SERVICE_NODE, timeoutMs: 3000 });
  return seen;
}

const write = (id: string, path: string, body: string): string => `---\nbushwhack: fs:write\nid: ${id}\npath: ${path}\n---\n${body}\n---end`;
const read = (id: string, path: string): string => `---\nbushwhack: fs:read\nid: ${id}\npath: ${path}\n---end`;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bw-service-'));
  dir = join(base, 'service');
  alpha = join(base, 'alpha');
  beta = join(base, 'beta');
  await mkdir(alpha);
  await mkdir(beta);
  await writeFile(join(alpha, 'only-alpha.txt'), 'alpha\n');
  await writeFile(join(beta, 'only-beta.txt'), 'beta\n');
  clients = [];
  await start();
  await service.add(alpha);
  await service.add(beta);
});

afterEach(async () => {
  for (const c of clients) c.close();
  await service.close();
  await rm(base, { recursive: true, force: true });
});

describe('the service', () => {
  it('serves several projects on one relay, one pairing code for all, and says so on /health', async () => {
    const health = (await (await fetch(`http://127.0.0.1:${service.port}/health`)).json()) as { daemon: string; sessions: { session: string; folder: string }[] };
    expect(health.daemon).toBe(service.id);
    expect(health.sessions.map((s) => s.session).sort()).toEqual(['alpha', 'beta']);
  });

  it('keeps each project in its own jail', async () => {
    const a = await bridgeTo(alpha);
    const reply = await a.call({ conversation: 'c', calls: [read('r1', 'only-alpha.txt'), read('r2', '../beta/only-beta.txt')] }, 5000);
    expect(reply.text).toContain('alpha');
    expect(reply.summary.map((s) => s.status)).toEqual(['ok', 'error']);
  });

  it('asks the operator\'s approvals client, naming the project, and writes on yes', async () => {
    const seen = await approvals((await readServiceFile(dir))!.operatorKey, () => ({ verdict: 'yes' }));
    const b = await bridgeTo(beta);
    await b.call({ conversation: 'c', calls: [write('w1', 'new.txt', 'hello')] }, 10_000);
    expect(await readFile(join(beta, 'new.txt'), 'utf8')).toBe('hello\n');
    expect(seen).toEqual([expect.objectContaining({ kind: SERVICE.approve, project: 'beta', tool: 'fs:write', id: 'w1', text: expect.stringContaining('new file new.txt') })]);
  });

  it('asks only the approvals terminal opened last, not every one open', async () => {
    const key = (await readServiceFile(dir))!.operatorKey;
    const older = await approvals(key, () => ({ verdict: 'no' }), true);
    const newer = await approvals(key, () => ({ verdict: 'yes' }), true);
    const a = await bridgeTo(alpha);
    await a.call({ conversation: 'c', calls: [write('w1', 'routed.txt', 'x')] }, 10_000);
    expect(newer).toHaveLength(1);
    expect(older).toHaveLength(0);
    expect(await readFile(join(alpha, 'routed.txt'), 'utf8')).toBe('x\n');
  });

  it('hands the approvals back to the terminal before, when the latest one closes', async () => {
    const key = (await readServiceFile(dir))!.operatorKey;
    const older = await approvals(key, () => ({ verdict: 'yes' }), true);
    await approvals(key, () => ({ verdict: 'no' }), true);
    clients.pop()!.close(); // the latest terminal leaves
    await new Promise((r) => setTimeout(r, 200));
    const a = await bridgeTo(alpha);
    const reply = await a.call({ conversation: 'c', calls: [write('w1', 'back.txt', 'x')] }, 10_000);
    expect(reply.summary[0].status).toBe('ok');
    expect(older).toHaveLength(1);
  });

  it('ignores an approval without the operator key: a client with the pairing code alone cannot approve', async () => {
    await approvals('a-guess', () => ({ verdict: 'yes' }));
    const a = await bridgeTo(alpha);
    const reply = await a.call({ conversation: 'c', calls: [write('w1', 'forged.txt', 'x')] }, 10_000);
    expect(reply.summary[0].status).toBe('denied');
    await expect(stat(join(alpha, 'forged.txt'))).rejects.toThrow();
  });

  it('refuses a call when nobody is at bushwhack approvals, after a while', async () => {
    const a = await bridgeTo(alpha);
    const reply = await a.call({ conversation: 'c', calls: [write('w1', 'waiting.txt', 'x')] }, 10_000);
    expect(reply.summary[0].status).toBe('denied');
  });

  it('takes a secret value from the approvals client, and never shows it', async () => {
    await writeFile(join(alpha, '.env'), '');
    await writeFile(join(alpha, '.bushwhack', 'secrets.jsonc'), JSON.stringify({ files: { '.env': { format: 'dotenv' } } }));
    const key = (await readServiceFile(dir))!.operatorKey;
    await approvals(key, (kind) => (kind === SERVICE.secret ? { value: 'sk-live-typed-here' } : { verdict: 'yes' }));
    const a = await bridgeTo(alpha);
    const reply = await a.call({ conversation: 'c', calls: ['---\nbushwhack: secret:add\nid: s1\nfile: .env\nname: API_KEY\n---end'] }, 10_000);
    expect(reply.summary[0].status).toBe('ok');
    expect(await readFile(join(alpha, '.env'), 'utf8')).toContain('API_KEY=sk-live-typed-here');
    expect(reply.text).not.toContain('sk-live-typed-here');
  });

  it('answers the CLI only with the operator key', async () => {
    const node = new HubNode({ nodeId: 'cli-test', defaultScope: 'global' });
    const transport = new WebSocketTransport({ name: 'relay', url: `ws://127.0.0.1:${service.port}`, peerPatterns: ['*'], reconnect: { maxAttempts: 1 }, registrationMessage: { type: 'register', nodeId: 'cli-test', securityKey: service.code, client: 'cli' } });
    node.addTransport(transport);
    await transport.connect();
    clients.push({ close: () => transport.disconnect() });
    const refused = await node.request(SERVICE.list, { key: 'nope' }, { target: SERVICE_NODE, timeoutMs: 3000 });
    expect(refused.payload).toEqual({ error: 'not the operator' });
    const key = (await readServiceFile(dir))!.operatorKey;
    const listed = (await node.request(SERVICE.list, { key }, { target: SERVICE_NODE, timeoutMs: 3000 })).payload as { projects: unknown[] };
    expect(listed.projects).toHaveLength(2);
  });

  it('sends the operator\'s prompt to the extension, and brings the chat\'s events back to the terminal', async () => {
    // A browser on the relay: takes prompts, reports what the chat shows.
    const sent: unknown[] = [];
    const ext = new HubNode({ nodeId: 'ext:test', defaultScope: 'global' });
    const extTransport = new WebSocketTransport({ name: 'relay', url: `ws://127.0.0.1:${service.port}`, peerPatterns: ['*'], reconnect: { maxAttempts: 1 }, registrationMessage: { type: 'register', nodeId: 'ext:test', securityKey: service.code, client: 'extension' } });
    ext.addTransport(extTransport);
    await extTransport.connect();
    clients.push({ close: () => extTransport.disconnect() });
    ext.on(CHAT.send, (payload: unknown, envelope) => {
      sent.push({ from: envelope.source, ...(payload as object) });
      ext.emit(CHAT.reply, { ok: true, conversation: 'gemini.google.com/abc' }, { target: envelope.source, replyToId: envelope.id });
    });

    const file = (await readServiceFile(dir))!;
    const terminal = await operatorClient(file, 'cli:terminal');
    clients.push(terminal);
    const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
    // No browser holds the chat yet: nothing to send to.
    expect(await terminal.chatSend(alphaNode, 'hello').catch((e: Error) => e.message)).toMatch(/no browser has a chat of this project open/);
    ext.emit(CHAT.here, { session: alphaNode, conversation: 'gemini.google.com/abc' }, { target: 'service:bushwhack' });
    await new Promise((r) => setTimeout(r, 100));
    // The list says which project is live in a chat, and where; the other is not.
    const { projects } = (await terminal.list()) as { projects: { nodeId: string; chat?: unknown }[] };
    expect(projects.find((p) => p.nodeId === alphaNode)?.chat).toEqual({ browser: 'a browser', conversation: 'gemini.google.com/abc' });
    expect(projects.find((p) => p.nodeId !== alphaNode)?.chat).toBeUndefined();
    const events: unknown[] = [];
    terminal.node.on(CHAT.event, (payload: unknown) => events.push(payload));
    await terminal.chatAttach(alphaNode);

    expect(await terminal.chatSend(alphaNode, 'list the project')).toEqual({ ok: true, conversation: 'gemini.google.com/abc' });
    expect(sent).toEqual([{ from: 'service:bushwhack', session: alphaNode, text: 'list the project' }]);
    // The manifest: asked of the extension, which makes it for the chat's driver.
    await terminal.chatManifest(alphaNode);
    expect(sent[1]).toEqual({ from: 'service:bushwhack', session: alphaNode, text: '', manifest: true });

    ext.emit(CHAT.event, { session: alphaNode, kind: 'answer', text: 'Here it is', done: true }, { target: 'service:bushwhack' });
    const betaNode = service.list().find((p) => p.folder === beta)!.nodeId;
    ext.emit(CHAT.event, { session: betaNode, kind: 'answer', text: 'not yours' }, { target: 'service:bushwhack' });
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toEqual([{ session: alphaNode, kind: 'answer', text: 'Here it is', done: true }]);
  });

  it('sends a project\'s approvals to the terminal following its chat, even when another opened later', async () => {
    const file = (await readServiceFile(dir))!;
    const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
    const asked: string[] = [];
    const terminal = async (name: string, follows?: string) => {
      const t = await operatorClient(file, name);
      clients.push(t);
      t.node.on(SERVICE.approve, (payload: unknown, envelope) => {
        asked.push(`${name} ${(payload as { project: string }).project}`);
        t.node.emit(SERVICE.approvalReply, { key: file.operatorKey, verdict: 'yes' }, { target: envelope.source, replyToId: envelope.id });
      });
      if (follows) await t.chatAttach(follows);
      await t.approvalsHere();
    };
    await terminal('approvals:alpha-chat', alphaNode);
    await terminal('approvals:latest');
    await (await bridgeTo(alpha)).call({ conversation: 'c', calls: [write('w1', 'a.txt', 'a')] }, 5000);
    await (await bridgeTo(beta)).call({ conversation: 'c', calls: [write('w1', 'b.txt', 'b')] }, 5000);
    expect(asked).toEqual(['approvals:alpha-chat alpha', 'approvals:latest beta']);
  });

  it('shows a chat\'s report:bug at once in the operator\'s terminal', async () => {
    const terminal = await operatorClient((await readServiceFile(dir))!, 'approvals:reports');
    clients.push(terminal);
    const shown: unknown[] = [];
    terminal.node.on(SERVICE.notice, (payload: unknown) => shown.push(payload));
    await terminal.approvalsHere();
    const bridge = await bridgeTo(alpha);
    const reply = await bridge.call({ conversation: 'c', calls: ['---\nbushwhack: report:bug\nid: b1\ntitle: fs:read cut the file\n---\nit stopped early\n---end'] }, 5000);
    expect(reply.summary[0].status).toBe('ok');
    await new Promise((r) => setTimeout(r, 100));
    expect(shown).toEqual([{ project: 'alpha', text: '🐞 fs:read cut the file' }]);
  });

  it('keeps the newer of two connections under one extension name, and the older stays out', async () => {
    const connect = async (): Promise<WebSocketTransport> => {
      const t = new WebSocketTransport({ name: 'relay', url: `ws://127.0.0.1:${service.port}`, peerPatterns: ['*'], reconnect: { maxAttempts: 3, initialDelay: 100 }, registrationMessage: { type: 'register', nodeId: 'ext:twice', securityKey: service.code, client: 'extension' } });
      await t.connect();
      clients.push({ close: () => t.disconnect() });
      return t;
    };
    const older = await connect();
    const newer = await connect();
    // Were the older to reconnect, it would take the name back, and the newer after it.
    await new Promise((r) => setTimeout(r, 800));
    expect(newer.state.connected).toBe(true);
    expect(older.state).toEqual({ connected: false, error: 'replaced by a newer connection' });
  });

  it('tells a project\'s terminals which chat its prompts go to, when that changes', async () => {
    const ext = new HubNode({ nodeId: 'ext:said', defaultScope: 'global' });
    const t = new WebSocketTransport({ name: 'relay', url: `ws://127.0.0.1:${service.port}`, peerPatterns: ['*'], reconnect: { maxAttempts: 1 }, registrationMessage: { type: 'register', nodeId: 'ext:said', securityKey: service.code, client: 'extension' } });
    ext.addTransport(t);
    await t.connect();
    clients.push({ close: () => t.disconnect() });
    const terminal = await operatorClient((await readServiceFile(dir))!, 'cli:said');
    clients.push(terminal);
    const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
    const said: unknown[] = [];
    terminal.node.on(CHAT.event, (payload: unknown) => said.push(payload));
    await terminal.chatAttach(alphaNode);
    const here = async (conversation: string | null, chat: string): Promise<void> => {
      ext.emit(CHAT.here, { session: alphaNode, conversation, chat }, { target: 'service:bushwhack' });
      await new Promise((r) => setTimeout(r, 100));
    };
    await here(null, 'Meta AI'); // bound: a new chat
    await here(null, 'Meta AI'); // the same, again: nothing to say
    await here('www.meta.ai/c1', 'Meta AI'); // its first message gives it an id: the same chat
    await here('gemini.google.com/g1', 'Gemini'); // another chat
    // The tab navigates away: the chat is left, at once — not 15 s later.
    ext.emit(CHAT.here, { session: alphaNode, left: true }, { target: 'service:bushwhack' });
    await new Promise((r) => setTimeout(r, 100));
    expect(said).toEqual([
      { session: alphaNode, kind: 'chat', text: 'Meta AI in a browser — a new conversation' },
      { session: alphaNode, kind: 'chat', text: 'Gemini in a browser — gemini.google.com/g1' },
      { session: alphaNode, kind: 'chat' },
    ]);
    const { projects } = (await terminal.list()) as { projects: { nodeId: string; chat?: unknown }[] };
    expect(projects.find((p) => p.nodeId === alphaNode)?.chat).toBeUndefined();
  });

  it('sends a prompt to the browser holding the project\'s chat, not to any browser', async () => {
    const received: string[] = [];
    for (const id of ['ext:chrome', 'ext:chromium']) {
      const ext = new HubNode({ nodeId: id, defaultScope: 'global' });
      const t = new WebSocketTransport({ name: 'relay', url: `ws://127.0.0.1:${service.port}`, peerPatterns: ['*'], reconnect: { maxAttempts: 1 }, registrationMessage: { type: 'register', nodeId: id, securityKey: service.code, client: 'extension' } });
      ext.addTransport(t);
      await t.connect();
      clients.push({ close: () => t.disconnect() });
      ext.on(CHAT.send, (_payload: unknown, envelope) => {
        received.push(id);
        ext.emit(CHAT.reply, { ok: true, conversation: id }, { target: envelope.source, replyToId: envelope.id });
      });
      // Only Chromium has alpha's chat open.
      if (id === 'ext:chromium') ext.emit(CHAT.here, { session: service.list().find((p) => p.folder === alpha)!.nodeId }, { target: 'service:bushwhack' });
    }
    await new Promise((r) => setTimeout(r, 100));
    const terminal = await operatorClient((await readServiceFile(dir))!, 'cli:terminal3');
    clients.push(terminal);
    const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
    for (let i = 0; i < 3; i++) await terminal.chatSend(alphaNode, `prompt ${i}`);
    expect(received).toEqual(['ext:chromium', 'ext:chromium', 'ext:chromium']);
  });

  it('sends nothing without the operator key, and takes chat events from an extension only', async () => {
    const intruder = new HubNode({ nodeId: 'cli:intruder', defaultScope: 'global' });
    const t = new WebSocketTransport({ name: 'relay', url: `ws://127.0.0.1:${service.port}`, peerPatterns: ['*'], reconnect: { maxAttempts: 1 }, registrationMessage: { type: 'register', nodeId: 'cli:intruder', securityKey: service.code, client: 'cli' } });
    intruder.addTransport(t);
    await t.connect();
    clients.push({ close: () => t.disconnect() });
    const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
    const refused = await intruder.request(SERVICE.chatSend, { key: 'guess', session: alphaNode, text: 'hi' }, { target: SERVICE_NODE, timeoutMs: 3000 });
    expect(refused.payload).toEqual({ error: 'not the operator, or nothing to send' });

    const file = (await readServiceFile(dir))!;
    const terminal = await operatorClient(file, 'cli:terminal2');
    clients.push(terminal);
    const events: unknown[] = [];
    terminal.node.on(CHAT.event, (payload: unknown) => events.push(payload));
    await terminal.chatAttach(alphaNode);
    intruder.emit(CHAT.event, { session: alphaNode, kind: 'answer', text: 'forged' }, { target: 'service:bushwhack' });
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toEqual([]);
  });

  it('keeps a terminal through a restart of the service: it reconnects, and the approvals come back to it', async () => {
    const answered: string[] = [];
    let back: () => void = () => {};
    const file = (await readServiceFile(dir))!;
    // The service coming back may not be ready for what the terminal asks: the first
    // attempt fails here, as it would there, and the terminal asks again.
    let attempts = 0;
    const terminal = await operatorClient(file, 'approvals:kept', {
      back: async () => {
        if (++attempts === 1) throw new Error('no such project (yet)');
        await terminal.approvalsHere();
        back();
      },
    });
    clients.push(terminal);
    terminal.node.on(SERVICE.approve, (payload: unknown, envelope) => {
      answered.push((payload as { tool: string }).tool);
      terminal.node.emit(SERVICE.approvalReply, { key: file.operatorKey, verdict: 'yes' }, { target: envelope.source, replyToId: envelope.id });
    });
    await terminal.approvalsHere();

    const reconnected = new Promise<void>((r) => (back = r));
    await service.close();
    // Down longer than one reconnect attempt: a terminal that tries once is gone by now.
    await new Promise((r) => setTimeout(r, 2500));
    await start();
    await reconnected;
    const out = await (await bridgeTo(alpha)).call({ conversation: 'c', calls: [write('w1', 'after.txt', 'hi')] }, 5000);
    expect(out.text).toContain('status: ok');
    expect(answered).toEqual(['fs:write']);
    expect(attempts).toBe(2);
  }, 15_000);

  it('keeps its saved project list whole while bringing it back', async () => {
    const listFile = join(dir, 'projects.json');
    await service.close();
    // Watch the list while the service restarts: it never shrinks.
    const seen: number[] = [];
    const watch = setInterval(() => void readFile(listFile, 'utf8').then((t) => seen.push((JSON.parse(t) as string[]).length), () => undefined), 5);
    await start();
    clearInterval(watch);
    expect(Math.min(...seen)).toBe(2);
    expect(service.list()).toHaveLength(2);
  });

  it('comes back after a restart with the same code and the same projects', async () => {
    const { code, id } = service;
    await service.remove(beta);
    await service.close();
    await start();
    expect(service.code).toBe(code);
    expect(service.id).toBe(id);
    expect(service.list().map((p) => p.session)).toEqual(['alpha']);
  });
});
