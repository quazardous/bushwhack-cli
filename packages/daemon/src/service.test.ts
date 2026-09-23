/**
 * The service: several projects on one relay and one pairing, each as isolated as under
 * `serve`, with approvals answered by whoever holds the operator key — and nobody else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubNode, WebSocketTransport } from '@bushwhack/hub';
import { APPROVAL, CHAT } from '@bushwhack/protocol';
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

async function start(approvalWaitMs = 2000, presenceMs?: number): Promise<void> {
  service = await startService({ dir, ports: PORTS, octopod: noOctopod, out: () => {}, env: { XDG_STATE_HOME: join(base, 'xdg') }, approvalWaitMs, ...(presenceMs ? { presenceMs } : {}) });
}

/** A browser on the service, as the extension registers: `answer` runs on each chat:who. */
async function browser(nodeId: string, answer?: (ext: HubNode) => void): Promise<HubNode> {
  const ext = new HubNode({ nodeId, defaultScope: 'global' });
  const t = new WebSocketTransport({ name: 'relay', url: `ws://127.0.0.1:${service.port}`, peerPatterns: ['*'], reconnect: { maxAttempts: 1 }, registrationMessage: { type: 'register', nodeId, securityKey: service.code, client: 'extension' } });
  ext.addTransport(t);
  await t.connect();
  clients.push({ close: () => t.disconnect() });
  if (answer) ext.on(CHAT.who, () => answer(ext));
  return ext;
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

  it('keeps an "always" in the project, logs every decision, and forgets on demand', async () => {
    const key = (await readServiceFile(dir))!.operatorKey;
    // `always`, as an older client answers: every file, yes.
    let verdict = 'always';
    const seen = await approvals(key, () => ({ verdict }));
    const b = await bridgeTo(beta);
    await b.call({ conversation: 'c', calls: [write('w1', 'one.txt', '1')] }, 10_000);
    verdict = 'no';
    await b.call({ conversation: 'c', calls: [write('w2', 'two.txt', '2')] }, 10_000);
    // Accepted by the rule, not asked.
    expect(seen.map((s) => s.id)).toEqual(['w1']);
    expect(await readFile(join(beta, 'two.txt'), 'utf8')).toBe('2\n');
    expect(JSON.parse(await readFile(join(beta, '.bushwhack', 'approval-rules.json'), 'utf8')).rules).toEqual([{ tools: 'change', pattern: '**', answer: 'yes', at: expect.any(String) }]);
    const node = new HubNode({ nodeId: 'cli-always', defaultScope: 'global' });
    const transport = new WebSocketTransport({ name: 'relay', url: `ws://127.0.0.1:${service.port}`, peerPatterns: ['*'], reconnect: { maxAttempts: 1 }, registrationMessage: { type: 'register', nodeId: 'cli-always', securityKey: service.code, client: 'cli' } });
    node.addTransport(transport);
    await transport.connect();
    clients.push({ close: () => transport.disconnect() });
    const cli = node;
    const ask = (payload: Record<string, unknown>) => cli.request(SERVICE.always, { key, ...payload }, { target: SERVICE_NODE, timeoutMs: 3000 }).then((r) => r.payload as { rules: unknown[]; forgotten: unknown[] });
    expect((await ask({})).rules).toEqual([{ project: 'beta', rule: 'change **', answer: 'yes' }]);
    // A tool names its kind: fs:write's rules are under "change".
    expect((await ask({ forget: 'fs:write' })).forgotten).toEqual([{ project: 'beta', rule: 'change **', answer: 'yes' }]);
    await b.call({ conversation: 'c', calls: [write('w3', 'three.txt', '3')] }, 10_000);
    expect(seen.map((s) => s.id)).toEqual(['w1', 'w3']);
    const log = (await readFile(join(beta, '.bushwhack', 'approvals.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(log.map((d) => [d.id, d.verdict, d.by, d.rule])).toEqual([['w1', 'yes', 'operator', undefined], ['w2', 'yes', 'rule', 'change **'], ['w3', 'no', 'operator', undefined]]);
    // Without the operator key, nothing.
    expect(((await cli.request(SERVICE.always, { key: 'guess' }, { target: SERVICE_NODE, timeoutMs: 3000 })).payload as { error?: string }).error).toBe('not the operator');
  });

  describe('remembered answers', () => {
    const rulesOf = async (folder: string) => JSON.parse(await readFile(join(folder, '.bushwhack', 'approval-rules.json'), 'utf8')).rules as Record<string, unknown>[];

    it('offers scopes from the path, and remembers the one picked: the next matching calls are not asked', async () => {
      const key = (await readServiceFile(dir))!.operatorKey;
      const seen = await approvals(key, (_kind, p) => (p.id === 'w1' ? { verdict: 'yes', remember: '**/*.js' } : { verdict: 'no' }));
      const a = await bridgeTo(alpha);
      await a.call({ conversation: 'c', calls: [write('w1', 'src/app/main.js', 'a')] }, 10_000);
      expect(seen[0]).toMatchObject({
        scopes: [
          { label: 'this file', pattern: 'src/app/main.js' },
          { label: 'the .js files in this folder', pattern: 'src/app/*.js' },
          { label: 'every .js file', pattern: '**/*.js' },
          { label: 'every file', pattern: '**' },
        ],
        preset: 0,
      });
      const reply = await a.call({ conversation: 'c', calls: [write('w2', 'lib/util.js', 'b'), write('w3', 'notes.txt', 'c')] }, 10_000);
      expect(reply.summary.map((r) => r.status)).toEqual(['ok', 'denied']);
      expect(seen.map((s) => s.id)).toEqual(['w1', 'w3']);
      expect(await rulesOf(alpha)).toEqual([{ tools: 'change', pattern: '**/*.js', answer: 'yes', at: expect.any(String) }]);
    });

    it('remembers a no: the next matching call is refused, and the model is told why', async () => {
      const key = (await readServiceFile(dir))!.operatorKey;
      const seen = await approvals(key, () => ({ verdict: 'no', remember: 'drafts/*.md' }));
      const a = await bridgeTo(alpha);
      await a.call({ conversation: 'c', calls: [write('w1', 'drafts/one.md', 'x')] }, 10_000);
      const reply = await a.call({ conversation: 'c', calls: [write('w2', 'drafts/two.md', 'y')] }, 10_000);
      expect(seen).toHaveLength(1);
      expect(reply.summary[0].status).toBe('denied');
      expect(reply.text).toContain('the operator said never for change drafts/*.md');
    });

    it('remembers nothing for a pattern that does not cover the call', async () => {
      const key = (await readServiceFile(dir))!.operatorKey;
      await approvals(key, () => ({ verdict: 'yes', remember: 'elsewhere/*' }));
      await (await bridgeTo(alpha)).call({ conversation: 'c', calls: [write('w1', 'here.txt', 'x')] }, 10_000);
      await expect(stat(join(alpha, '.bushwhack', 'approval-rules.json'))).rejects.toThrow();
    });

    it('reads the file at each call: a rule written by hand counts at once, and a file not valid counts for nothing', async () => {
      const file = (await readServiceFile(dir))!;
      const lines: string[] = [];
      const asked: string[] = [];
      const t = await operatorClient(file, 'approvals:hand');
      clients.push(t);
      t.node.on(SERVICE.notice, (payload: unknown) => lines.push(String((payload as { text: unknown }).text)));
      t.node.on(SERVICE.approve, (payload: unknown, envelope) => {
        asked.push(String((payload as { id: unknown }).id));
        t.node.emit(SERVICE.approvalReply, { key: file.operatorKey, verdict: 'yes' }, { target: envelope.source, replyToId: envelope.id });
      });
      await t.approvalsHere();
      const a = await bridgeTo(alpha);
      await writeFile(join(alpha, '.bushwhack', 'approval-rules.json'), JSON.stringify({ rules: [{ tools: 'change', pattern: '*.txt', answer: 'yes' }] }));
      await a.call({ conversation: 'c', calls: [write('w1', 'by-hand.txt', 'x')] }, 10_000);
      expect(asked).toEqual([]);
      await writeFile(join(alpha, '.bushwhack', 'approval-rules.json'), '{ "rules": [ { "tools": "fs:write", "pattern": "*.txt", "answer": "yes" } ] }');
      await a.call({ conversation: 'c', calls: [write('w2', 'again.txt', 'y'), write('w3', 'more.txt', 'z')] }, 10_000);
      expect(asked).toEqual(['w2', 'w3']);
      // Said once, not at every call.
      expect(lines.filter((l) => l.startsWith('⚠'))).toEqual(['⚠ approval-rules.json: rule 1: fs:write rules are under "change" — its rules count for nothing until it is fixed: every call is asked']);
    });

    it('keeps the rules out of the model\'s reach', async () => {
      await writeFile(join(alpha, '.bushwhack', 'approval-rules.json'), JSON.stringify({ rules: [] }));
      const reply = await (await bridgeTo(alpha)).call({ conversation: 'c', calls: [read('r1', '.bushwhack/approval-rules.json')] }, 5000);
      expect(reply.summary[0].status).toBe('error');
    });
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

  it('tells the project\'s other terminals where a call waits, and its answer: not stuck', async () => {
    const key = (await readServiceFile(dir))!.operatorKey;
    const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
    await approvals(key, () => ({ verdict: 'yes' }), true);
    const lines: string[] = [];
    const plain = await operatorClient((await readServiceFile(dir))!, 'chat:plain');
    clients.push(plain);
    plain.node.on(SERVICE.notice, (payload: unknown) => lines.push(String((payload as { text: unknown }).text)));
    await plain.chatAttach(alphaNode);
    await (await bridgeTo(alpha)).call({ conversation: 'c', calls: [write('w1', 'waits.txt', 'x')] }, 5000);
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toEqual(['⏳ w1 fs:write — waiting for your yes in the bushwhack approvals terminal', '✓ w1 fs:write — accepted in the bushwhack approvals terminal']);
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

  describe('with no terminal taking approvals', () => {
    /** A browser answering approvals with `verdict` (none: it keeps them), and what it was told. */
    async function approvingBrowser(nodeId: string, verdict?: string, holds?: string) {
      const seen = { asked: [] as Record<string, unknown>[], done: [] as unknown[], notices: [] as Record<string, unknown>[], envelopes: [] as string[] };
      const ext = await browser(nodeId);
      ext.on(APPROVAL.ask, (payload: unknown, envelope) => {
        seen.asked.push(payload as Record<string, unknown>);
        seen.envelopes.push(envelope.id);
        if (verdict) ext.emit(APPROVAL.reply, { verdict }, { target: envelope.source, replyToId: envelope.id });
      });
      ext.on(APPROVAL.done, (payload: unknown) => seen.done.push(payload));
      ext.on(APPROVAL.notice, (payload: unknown) => seen.notices.push(payload as Record<string, unknown>));
      if (holds) ext.emit(CHAT.here, { session: holds, conversation: 'meta.ai/c1', chat: 'Meta AI' }, { target: SERVICE_NODE });
      await new Promise((r) => setTimeout(r, 100));
      return { ext, seen };
    }
    /** A terminal following the project's chat without taking approvals: the lines it is told. */
    async function follower(session: string): Promise<string[]> {
      const lines: string[] = [];
      const t = await operatorClient((await readServiceFile(dir))!, 'chat:follower');
      clients.push(t);
      t.node.on(SERVICE.notice, (payload: unknown) => lines.push(String((payload as { text: unknown }).text)));
      await t.chatAttach(session);
      return lines;
    }

    it('asks the browser holding the project\'s chat, tells the project\'s terminal, and logs the answer', async () => {
      const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
      const other = await approvingBrowser('ext:other', 'no');
      const holder = await approvingBrowser('ext:holder', 'yes', alphaNode);
      const lines = await follower(alphaNode);
      const reply = await (await bridgeTo(alpha)).call({ conversation: 'c', calls: [write('w1', 'from-browser.txt', 'hi')] }, 5000);
      expect(reply.summary[0].status).toBe('ok');
      expect(await readFile(join(alpha, 'from-browser.txt'), 'utf8')).toBe('hi\n');
      expect(holder.seen.asked).toEqual([expect.objectContaining({ project: 'alpha', id: 'w1', tool: 'fs:write', path: 'from-browser.txt', text: expect.stringContaining('new file') })]);
      expect(other.seen.asked).toEqual([]);
      await new Promise((r) => setTimeout(r, 100));
      expect(holder.seen.done).toEqual([{ project: 'alpha', id: 'w1' }]);
      expect(lines).toEqual(['⏳ w1 fs:write — waiting for your yes in the browser', '✓ w1 fs:write — accepted in the browser']);
      const log = (await readFile(join(alpha, '.bushwhack', 'approvals.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(log.at(-1)).toMatchObject({ id: 'w1', tool: 'fs:write', verdict: 'yes', by: 'browser' });
    });

    it('asks a browser again when it comes back: a reloaded extension has lost what it was holding', async () => {
      const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
      // The first copy gets the question and is gone (its extension reloaded) without answering.
      const at = clients.length;
      const first = await approvingBrowser('ext:reloaded', undefined, alphaNode);
      const call = (await bridgeTo(alpha)).call({ conversation: 'c', calls: [write('w1', 'after-reload.txt', 'x')] }, 10_000);
      await new Promise((r) => setTimeout(r, 300));
      expect(first.seen.asked).toHaveLength(1);
      clients[at].close();
      await new Promise((r) => setTimeout(r, 100));
      // The same browser back, fresh: it is asked again, and its answer counts.
      const again = await approvingBrowser('ext:reloaded', 'yes');
      expect((await call).summary[0].status).toBe('ok');
      expect(again.seen.asked).toEqual([expect.objectContaining({ id: 'w1', tool: 'fs:write' })]);
      expect(await readFile(join(alpha, 'after-reload.txt'), 'utf8')).toBe('x\n');
    });

    it('takes the answer from the browser it asked only', async () => {
      const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
      const holder = await approvingBrowser('ext:holder', undefined, alphaNode);
      const intruder = await browser('ext:intruder');
      // The intruder answers the very request the holder got.
      holder.ext.on(APPROVAL.ask, () => setTimeout(() => intruder.emit(APPROVAL.reply, { verdict: 'yes' }, { target: SERVICE_NODE, replyToId: holder.seen.envelopes[0] }), 50));
      const reply = await (await bridgeTo(alpha)).call({ conversation: 'c', calls: [write('w1', 'forged.txt', 'x')] }, 10_000);
      expect(reply.summary[0].status).toBe('denied');
      await expect(stat(join(alpha, 'forged.txt'))).rejects.toThrow();
    });

    it('asks a terminal taking approvals first, never the browser', async () => {
      const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
      const holder = await approvingBrowser('ext:holder', 'no', alphaNode);
      const seen = await approvals((await readServiceFile(dir))!.operatorKey, () => ({ verdict: 'yes' }), true);
      await (await bridgeTo(alpha)).call({ conversation: 'c', calls: [write('w1', 'terminal.txt', 't')] }, 5000);
      expect(seen).toHaveLength(1);
      expect(holder.seen.asked).toEqual([]);
    });

    it('never asks a secret value in the browser: it says so there, and waits for a terminal', async () => {
      await writeFile(join(alpha, '.env'), '');
      await writeFile(join(alpha, '.bushwhack', 'secrets.jsonc'), JSON.stringify({ files: { '.env': { format: 'dotenv' } } }));
      const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
      const holder = await approvingBrowser('ext:holder', 'yes', alphaNode);
      const call = (await bridgeTo(alpha)).call({ conversation: 'c', calls: ['---\nbushwhack: secret:add\nid: s1\nfile: .env\nname: API_KEY\n---end'] }, 10_000);
      await new Promise((r) => setTimeout(r, 400));
      expect(holder.seen.notices).toEqual([expect.objectContaining({ secret: true, text: expect.stringContaining('bushwhack --approve-here') })]);
      await approvals((await readServiceFile(dir))!.operatorKey, (kind) => (kind === SERVICE.secret ? { value: 'typed-in-a-terminal' } : { verdict: 'yes' }), true);
      expect((await call).summary[0].status).toBe('ok');
      expect(await readFile(join(alpha, '.env'), 'utf8')).toContain('API_KEY=typed-in-a-terminal');
      expect(holder.seen.asked).toEqual([]);
    });
  });

  it('tells the browsers which terminals follow a project\'s chat, and where its approvals go', async () => {
    const file = (await readServiceFile(dir))!;
    const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
    const seen: { terminals: number; approvals: string }[] = [];
    const ext = await browser('ext:page');
    ext.on(CHAT.terminals, (payload: unknown) => {
      const t = payload as { session: string; terminals: number; approvals: string };
      if (t.session === alphaNode) seen.push({ terminals: t.terminals, approvals: t.approvals });
    });
    const latest = async () => (await new Promise((r) => setTimeout(r, 150)), seen.at(-1));
    // A page that says it holds the chat is told at once: nobody yet.
    ext.emit(CHAT.here, { session: alphaNode, conversation: 'meta.ai/c1' }, { target: SERVICE_NODE });
    expect(await latest()).toEqual({ terminals: 0, approvals: 'browser' });
    // A terminal follows the chat, not taking approvals.
    const chat = await operatorClient(file, 'chat:plain');
    await chat.chatAttach(alphaNode);
    expect(await latest()).toEqual({ terminals: 1, approvals: 'browser' });
    // One with --approve-here: the approvals are asked there.
    const approving = await operatorClient(file, 'approvals:here');
    await approving.chatAttach(alphaNode);
    await approving.approvalsHere();
    expect(await latest()).toEqual({ terminals: 2, approvals: 'here' });
    // It leaves: back to the browser.
    approving.close();
    expect(await latest()).toEqual({ terminals: 1, approvals: 'browser' });
    chat.close();
    expect(await latest()).toEqual({ terminals: 0, approvals: 'browser' });
  });

  it('lists a project\'s terminals for the panel, and closes one when a browser asks — only one of that project', async () => {
    const file = (await readServiceFile(dir))!;
    const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
    const lists: { id: string; approves: boolean; label?: string }[][] = [];
    const ext = await browser('ext:panel');
    ext.on(CHAT.terminals, (payload: unknown) => {
      const t = payload as { session: string; list?: { id: string; approves: boolean; label?: string }[] };
      if (t.session === alphaNode && t.list) lists.push(t.list.map(({ id, approves, label }) => ({ id, approves, ...(label ? { label } : {}) })));
    });
    const closed: unknown[] = [];
    const t = await operatorClient(file, 'approvals:far');
    clients.push(t);
    t.node.on(SERVICE.close, (payload: unknown) => closed.push(payload));
    await t.chatAttach(alphaNode, 'pid 4242 · pts/7');
    await t.approvalsHere();
    await new Promise((r) => setTimeout(r, 150));
    expect(lists.at(-1)).toEqual([{ id: 'approvals:far', approves: true, label: 'pid 4242 · pts/7' }]);
    const close = (terminal: string, session = alphaNode) => ext.request(CHAT.closeTerminal, { session, terminal }, { target: SERVICE_NODE, timeoutMs: 3000 }).then((r) => r.payload);
    expect(await close('ext:panel')).toEqual({ error: 'no such terminal on this project' });
    expect(await close('approvals:far', service.list().find((p) => p.folder === beta)!.nodeId)).toEqual({ error: 'no such terminal on this project' });
    expect(await close('approvals:far')).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toEqual([{ by: 'a browser' }]);
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

  it('masks the project\'s secrets in a shell command\'s output sent to the chat', async () => {
    await writeFile(join(alpha, '.env'), 'API_KEY=sk-live-not-for-the-chat\n');
    await writeFile(join(alpha, '.bushwhack', 'secrets.jsonc'), JSON.stringify({ files: { '.env': { format: 'dotenv' } } }));
    const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
    const sent: string[] = [];
    const ext = await browser('ext:shell');
    ext.on(CHAT.send, (payload: unknown, envelope) => {
      sent.push((payload as { text: string }).text);
      ext.emit(CHAT.reply, { ok: true, conversation: 'meta.ai/c' }, { target: envelope.source, replyToId: envelope.id });
    });
    ext.emit(CHAT.here, { session: alphaNode, conversation: 'meta.ai/c' }, { target: SERVICE_NODE });
    await new Promise((r) => setTimeout(r, 100));
    const t = await operatorClient((await readServiceFile(dir))!, 'cli:shell');
    clients.push(t);
    await t.chatSendShell(alphaNode, 'I ran this:\n$ cat .env\nAPI_KEY=sk-live-not-for-the-chat');
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('sk-live-not-for-the-chat');
    expect(sent[0]).toContain('$ cat .env');
    // A prompt typed by the operator goes as it is.
    await t.chatSend(alphaNode, 'the key is sk-live-not-for-the-chat');
    expect(sent[1]).toBe('the key is sk-live-not-for-the-chat');
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

  it('asks the browsers which chats they show when a terminal opens: it starts knowing, without waiting for a heartbeat', async () => {
    const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
    let asked = 0;
    await browser('ext:asked', (ext) => {
      asked++;
      ext.emit(CHAT.here, { session: alphaNode, conversation: 'gemini.google.com/g1', chat: 'Gemini' }, { target: SERVICE_NODE });
    });
    const terminal = await operatorClient((await readServiceFile(dir))!, 'cli:opens');
    clients.push(terminal);
    await terminal.chatAttach(alphaNode);
    const { projects } = (await terminal.list()) as { projects: { nodeId: string; chat?: { chat?: string; conversation?: string } }[] };
    expect(projects.find((p) => p.nodeId === alphaNode)!.chat).toMatchObject({ chat: 'Gemini', conversation: 'gemini.google.com/g1' });
    // Known now: the next terminal does not ask again.
    const second = await operatorClient((await readServiceFile(dir))!, 'cli:second');
    clients.push(second);
    await second.chatAttach(alphaNode);
    expect(asked).toBe(1);
  });

  it('tells its terminals of a chat back after going silent — those opened meanwhile heard there was none', async () => {
    await service.close();
    await start(2000, 300);
    const alphaNode = service.list().find((p) => p.folder === alpha)!.nodeId;
    const ext = await browser('ext:silent');
    const here = (): void => void ext.emit(CHAT.here, { session: alphaNode, conversation: 'gemini.google.com/g1', chat: 'Gemini' }, { target: SERVICE_NODE });
    here();
    await new Promise((r) => setTimeout(r, 100));
    // Silent longer than the presence lasts: gone, without a word.
    await new Promise((r) => setTimeout(r, 400));
    const terminal = await operatorClient((await readServiceFile(dir))!, 'cli:meanwhile');
    clients.push(terminal);
    const said: unknown[] = [];
    terminal.node.on(CHAT.event, (payload: unknown) => said.push(payload));
    await terminal.chatAttach(alphaNode);
    here();
    await new Promise((r) => setTimeout(r, 100));
    expect(said).toEqual([{ session: alphaNode, kind: 'chat', text: expect.stringContaining('Gemini') }]);
  });

  it('does not take its own leaving for a lost service: closed, a terminal is told nothing', async () => {
    const lost: string[] = [];
    const terminal = await operatorClient((await readServiceFile(dir))!, 'approvals:leaving', { lost: () => lost.push('lost'), back: () => void lost.push('back') });
    await terminal.approvalsHere();
    terminal.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(lost).toEqual([]);
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
    const look = (): Promise<unknown> => readFile(listFile, 'utf8').then((t) => seen.push((JSON.parse(t) as string[]).length), () => undefined);
    const watch = setInterval(() => void look(), 5);
    // Before and after too: a restart faster than the first tick would leave nothing seen.
    await look();
    await start();
    clearInterval(watch);
    await look();
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
