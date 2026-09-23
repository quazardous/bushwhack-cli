/**
 * The page:* tools over the bridge, with fake browsers on the relay: what the daemon sends
 * (origins it decided, to the extension that asked) and what it does with the answer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubNode, WebSocketTransport } from '@bushwhack/hub';
import { BRIDGE, type ToolsCallReply, type ToolsCallRequest } from '@bushwhack/protocol';
import { PAGE_ACT, PAGE_REPLY, type PageOutcome, type PageRequest } from '@bushwhack/page/daemon';
import { connectBridge, type BridgeClient } from './bridge-client.js';
import type { Approver } from './dispatcher.js';
import type { OctopodClient, OctopodStatus } from './octopod-client.js';
import { APP_SETTLE } from './app.js';

// The app is watched after it starts: not for seconds, in these tests.
APP_SETTLE.ms = 30;
APP_SETTLE.every = 10;
import { serve, type Serving } from './serve.js';

const PORTS = [19490, 19491];
const PICTURE = 'data:image/png;base64,iVBORw0KGgo=';

let base: string;
let folder: string;
let serving: Serving;
let clients: { close(): void }[];

const approver: Approver = { ask: async () => 'yes', secretValue: async () => undefined };

function fakeOctopod(): OctopodClient {
  const status = (name: string): OctopodStatus => ({
    name,
    root: '',
    routes: [{ service: 'app', url: `http://${name}.localhost/` }],
    services: [{ service: 'app', state: 'running' }],
  });
  return {
    available: async () => true,
    register: async () => ({ name: 'demo', routes: [] }),
    plan: async () => ({ project: 'demo', text: '', services: [{ name: 'app', recipe: 'node-app', digest: 'd', workspace: '/app' }] }),
    recipes: async () => [{ id: 'node-app', title: 'Node', summary: 's', digest: 'd' }],
    up: async (name) => status(name),
    status: async (name) => status(name),
    restart: async (name) => status(name),
    exec: async () => ({ ok: true, output: '', truncated: false }),
    logs: async () => [],
    unregister: async () => {},
  };
}

interface FakeBrowser extends Array<PageRequest> {
  /** Sends tool calls from this node, as the extension does. */
  call(request: ToolsCallRequest): Promise<ToolsCallReply>;
}

/** A browser on the relay: records what it is asked, answers with `answer`. */
async function fakeBrowser(nodeId: string, answer: (r: PageRequest) => PageOutcome | { error: string }): Promise<FakeBrowser> {
  const seen = [] as unknown as FakeBrowser;
  const node = new HubNode({ nodeId, defaultScope: 'global' });
  const transport = new WebSocketTransport({
    name: 'relay',
    url: `ws://127.0.0.1:${serving.port}`,
    peerPatterns: ['*'],
    reconnect: { maxAttempts: 1 },
    registrationMessage: { type: 'register', nodeId, securityKey: serving.code, client: 'extension' },
  });
  node.addTransport(transport);
  await transport.connect();
  node.on(PAGE_ACT, (payload: unknown, envelope) => {
    seen.push(payload as PageRequest);
    node.emit(PAGE_REPLY, answer(payload as PageRequest), { target: envelope.source, replyToId: envelope.id });
  });
  clients.push({ close: () => transport.disconnect() });
  seen.call = async (request) => (await node.request(BRIDGE.call, request, { target: serving.session.nodeId, timeoutMs: 5000 })).payload as ToolsCallReply;
  return seen;
}

async function client(nodeId: string): Promise<BridgeClient> {
  const bridge = await connectBridge({ port: serving.port, code: serving.code, daemonNodeId: serving.session.nodeId, nodeId, client: 'test' });
  clients.push(bridge);
  return bridge;
}

const call = (id: string, tool: string, args: Record<string, string> = {}): string =>
  ['---', `bushwhack: ${tool}`, `id: ${id}`, ...Object.entries(args).map(([k, v]) => `${k}: ${v}`), '---end'].join('\n');

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bw-page-'));
  folder = join(base, 'demo');
  await mkdir(folder);
  clients = [];
  serving = await serve({ folder, approver, ports: PORTS, out: () => {}, env: { XDG_STATE_HOME: join(base, 'state') }, octopod: fakeOctopod() });
});

afterEach(async () => {
  for (const c of clients) c.close();
  await serving.close();
  await rm(base, { recursive: true, force: true });
});

async function withApp(bridge: BridgeClient): Promise<void> {
  await bridge.call({ conversation: 'c', calls: [call('a0', 'app:create', { stack: 'node-app' })] }, 5000);
}

describe('page tools', () => {
  it('are offered with the app tools', async () => {
    const bridge = await client('cli-1');
    expect((await bridge.list()).tools).toEqual(expect.arrayContaining(['page:open', 'page:snapshot', 'page:screenshot']));
  });

  it('refuse to run before there is an app, without asking any browser', async () => {
    const seen = await fakeBrowser('ext:one', () => ({ status: 'ok', content: 'x' }));
    const bridge = await client('cli-1');
    const reply = await bridge.call({ conversation: 'c', calls: [call('p1', 'page:snapshot')] }, 5000);
    expect(reply.text).toContain('app:create first');
    expect([...seen]).toEqual([]);
  });

  it('go back to the extension that sent the call, with the origins the daemon decided', async () => {
    const one = await fakeBrowser('ext:one', () => ({ status: 'ok', content: 'from one' }));
    const two = await fakeBrowser('ext:two', () => ({ status: 'ok', content: 'from two' }));
    await withApp(await client('cli-1'));
    const reply = await two.call({ conversation: 'c', calls: [call('p1', 'page:open', { path: '/about' })] });
    expect(reply.text).toContain('from two');
    expect([...one]).toEqual([]);
    expect([...two]).toEqual([
      { session: serving.session.nodeId, name: 'demo', origins: ['http://demo.localhost'], action: 'open', args: { path: '/about' } },
    ]);
  });

  it('carry a screenshot beside the result, never in the replay store', async () => {
    await fakeBrowser('ext:one', () => ({ status: 'ok', meta: { image: 'attached' }, content: 'a picture is attached', image: PICTURE }));
    const bridge = await client('cli-1');
    await withApp(bridge);
    const first = await bridge.call({ conversation: 'c', calls: [call('s1', 'page:screenshot')] }, 5000);
    expect(first.images).toEqual([{ id: 's1', image: PICTURE }]);
    expect(first.text).not.toContain('base64');
    expect(await readFile(join(folder, '.bushwhack', 'calls.jsonl'), 'utf8')).not.toContain('base64');

    const replay = await bridge.call({ conversation: 'c', calls: [call('s1', 'page:screenshot')] }, 5000);
    expect(replay.images).toBeUndefined();
    expect(replay.text).toContain('a new page:screenshot takes a new one');
  });

  it('refuse an image that is not a picture', async () => {
    await fakeBrowser('ext:one', () => ({ status: 'ok', content: 'x', image: 'javascript:alert(1)' }));
    const bridge = await client('cli-1');
    await withApp(bridge);
    const reply = await bridge.call({ conversation: 'c', calls: [call('s1', 'page:screenshot')] }, 5000);
    expect(reply.text).toContain('not a page result');
    expect(reply.images).toBeUndefined();
  });

  it('mask declared secret values in what the page shows', async () => {
    await mkdir(join(folder, 'app'));
    await writeFile(join(folder, 'app', '.env'), 'API_KEY=sk-live-123456\n');
    await writeFile(join(folder, '.bushwhack', 'secrets.jsonc'), JSON.stringify({ files: { 'app/.env': { format: 'dotenv' } } }));
    await fakeBrowser('ext:one', () => ({ status: 'ok', content: 'Your key: sk-live-123456' }));
    const bridge = await client('cli-1');
    await withApp(bridge);
    const reply = await bridge.call({ conversation: 'c', calls: [call('p1', 'page:snapshot')] }, 5000);
    expect(reply.text).not.toContain('sk-live-123456');
    expect(reply.text).toContain('‹secret:API_KEY›');
  });
});
