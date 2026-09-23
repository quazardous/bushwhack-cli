/**
 * The whole bridge, without a browser: a real `serve` on a temporary folder, a hub client
 * paired with its code, and calls going through the relay the way the extension sends
 * them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectBridge, type BridgeClient } from './bridge-client.js';
import type { Approver, Verdict } from './dispatcher.js';
import { serve, AlreadyServing, type Serving } from './serve.js';
import type { OctopodClient } from './octopod-client.js';
import { MAX_REPORTS_PER_CONVERSATION, readReports } from './reports.js';
import { VERSION } from './version.js';

const PORTS = [19470, 19471, 19472];

let base: string;
let folder: string;
let serving: Serving;
let bridge: BridgeClient;
let asked: string[];
let verdict: Verdict;
let secretAnswer: string | undefined;

const approver: Approver = {
  async ask(call) {
    asked.push(`${call.id} ${call.tool}`);
    return verdict;
  },
  async secretValue(request) {
    asked.push(`${request.id} value ${request.name}`);
    return secretAnswer;
  },
  notice(text) {
    notices.push(text);
  },
};
let notices: string[] = [];

// No octopod: these tests are about files and secrets, and must not wait on the machine's own.
const noOctopod = { available: async () => false } as unknown as OctopodClient;

const env = (): NodeJS.ProcessEnv => ({ XDG_STATE_HOME: join(base, 'state') });

async function start(): Promise<void> {
  serving = await serve({ folder, approver, ports: PORTS, out: () => {}, env: env(), octopod: noOctopod });
  bridge = await connectBridge({
    port: serving.port,
    code: serving.code,
    daemonNodeId: serving.session.nodeId,
    nodeId: 'test-client',
    client: 'test',
  });
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bw-serve-'));
  folder = join(base, 'Demo Project');
  await mkdir(folder);
  await writeFile(join(folder, '.gitignore'), '.env\n');
  await writeFile(join(folder, '.env'), 'TOKEN=x');
  await writeFile(join(folder, 'README.md'), '# demo\n');
  asked = [];
  notices = [];
  verdict = 'yes';
  secretAnswer = undefined;
  await start();
});

afterEach(async () => {
  bridge.close();
  await serving.close();
  await rm(base, { recursive: true, force: true });
});

const read = (id: string, path: string): string => `---\nbushwhack: fs:read\nid: ${id}\npath: ${path}\n---end`;
const write = (id: string, path: string, body: string): string => `---\nbushwhack: fs:write\nid: ${id}\npath: ${path}\n---\n${body}\n---end`;

describe('serve', () => {
  it('names the session after the folder and keeps its state in it, hidden', async () => {
    expect(serving.session.name).toBe('demo-project');
    expect(serving.session.stateDir).toBe(join(folder, '.bushwhack'));
    const reply = await bridge.call({ conversation: 'meta.ai/c1', calls: [read('h1', '.bushwhack/pairing.json')] }, 5000);
    expect(reply.text).toContain('does not exist');
    expect(reply.text).not.toContain(serving.code);
  });

  it('keeps .bushwhack/ out of git without touching the project\'s .gitignore', async () => {
    await bridge.close();
    await serving.close();
    await mkdir(join(folder, '.git', 'info'), { recursive: true });
    await writeFile(join(folder, '.git', 'info', 'exclude'), '# local\n*.swp');
    await start();
    bridge.close();
    await serving.close();
    await start();
    expect(await readFile(join(folder, '.git', 'info', 'exclude'), 'utf8')).toBe('# local\n*.swp\n/.bushwhack/\n');
    expect(await readFile(join(folder, '.gitignore'), 'utf8')).toBe('.env\n');
  });

  it('hands out the manifest', async () => {
    const list = await bridge.list();
    expect(list.tools).toContain('fs:write');
    expect(list.manifest).toContain('project "demo-project"');
  });

  it('adds the chat\'s own prompt to the manifest, and drops one that breaks the bounds', async () => {
    const chat = { title: 'Fixture Chat', preamble: 'You are in a fixture.', notes: ['One call per block.'] };
    const withChat = await bridge.list({ chat });
    expect(withChat.manifest).toContain('You are in a fixture.');
    expect(withChat.manifest).toContain('## In Fixture Chat\n\n- One call per block.');

    const oversized = await bridge.list({ chat: { ...chat, notes: ['x'.repeat(401)] } });
    expect(oversized.manifest).not.toContain('Fixture Chat');
  });

  it('runs calls in order and answers with result blocks', async () => {
    const reply = await bridge.call({ conversation: 'meta.ai/c1', calls: [read('c1', 'README.md'), read('c2', '.env')] }, 5000);
    expect(reply.summary).toEqual([
      { id: 'c1', tool: 'fs:read', status: 'ok', replay: false },
      { id: 'c2', tool: 'fs:read', status: 'error', replay: false, error: expect.stringContaining('".env" does not exist') },
    ]);
    expect(reply.text).toContain('bushwhack-result: fs:read\nid: c1\nstatus: ok');
    expect(reply.text).toContain('# demo');
    expect(reply.text).toContain('".env" does not exist');
  });

  it('asks before writing, and writes nothing when refused', async () => {
    verdict = 'no';
    const reply = await bridge.call({ conversation: 'meta.ai/c1', calls: [write('w1', 'a.txt', 'hello')] }, 5000);
    expect(asked).toEqual(['w1 fs:write']);
    expect(reply.summary[0].status).toBe('denied');
    await expect(readFile(join(folder, 'a.txt'), 'utf8')).rejects.toThrow();
  });

  it('runs nothing after a refused call in the same answer, and runs it when sent again', async () => {
    verdict = 'no';
    const reply = await bridge.call({ conversation: 'meta.ai/c1', calls: [write('w1', 'a.txt', 'a'), write('w2', 'b.txt', 'b'), read('r1', 'README.md')] }, 5000);
    // Asked once: the rest is not even put to the operator.
    expect(asked).toEqual(['w1 fs:write']);
    expect(reply.summary.map((s) => s.status)).toEqual(['denied', 'skipped', 'skipped']);
    expect(reply.text).toContain('w1 was denied just before it');
    await expect(readFile(join(folder, 'b.txt'), 'utf8')).rejects.toThrow();
    // Not recorded as skipped: the same call, sent again, runs.
    verdict = 'yes';
    const again = await bridge.call({ conversation: 'meta.ai/c1', calls: [write('w2', 'b.txt', 'b')] }, 5000);
    expect(again.summary[0].status).toBe('ok');
    expect(await readFile(join(folder, 'b.txt'), 'utf8')).toBe('b\n');
  });

  it('answers a replay from the store instead of running it again', async () => {
    const call = write('w1', 'a.txt', 'hello');
    await bridge.call({ conversation: 'meta.ai/c1', calls: [call] }, 5000);
    await writeFile(join(folder, 'a.txt'), 'changed by hand');

    const again = await bridge.call({ conversation: 'meta.ai/c1', calls: [call] }, 5000);

    expect(again.summary[0]).toMatchObject({ status: 'ok', replay: true });
    expect(asked).toEqual(['w1 fs:write']);
    expect(await readFile(join(folder, 'a.txt'), 'utf8')).toBe('changed by hand');
  });

  it('remembers replays across a daemon restart', async () => {
    const call = write('w1', 'a.txt', 'hello');
    await bridge.call({ conversation: 'meta.ai/c1', calls: [call] }, 5000);
    bridge.close();
    await serving.close();
    await start();

    const again = await bridge.call({ conversation: 'meta.ai/c1', calls: [call] }, 5000);
    expect(again.summary[0].replay).toBe(true);
    expect(asked).toEqual(['w1 fs:write']);
  });

  it('refuses a reused id for a different call, and keeps the same id free in another conversation', async () => {
    await bridge.call({ conversation: 'meta.ai/c1', calls: [read('c1', 'README.md')] }, 5000);
    const reused = await bridge.call({ conversation: 'meta.ai/c1', calls: [write('c1', 'a.txt', 'x')] }, 5000);
    expect(reused.text).toContain('already used');
    expect(asked).toEqual([]);

    const elsewhere = await bridge.call({ conversation: 'meta.ai/c2', calls: [read('c1', 'README.md')] }, 5000);
    expect(elsewhere.summary[0]).toMatchObject({ status: 'ok', replay: false });
  });

  it('fails to connect with a wrong pairing code, instead of looking connected', async () => {
    await expect(
      connectBridge({ port: serving.port, code: 'AAAA-BBBB-CCCC', daemonNodeId: serving.session.nodeId, nodeId: 'intruder', client: 'test' }),
    ).rejects.toThrow(/refused/);
  });

  it('keeps the pairing code across restarts', async () => {
    const code = serving.code;
    bridge.close();
    await serving.close();
    await start();
    expect(serving.code).toBe(code);
  });

  it('refuses to serve the same folder twice', async () => {
    await expect(serve({ folder, approver, ports: PORTS, out: () => {}, env: env() })).rejects.toBeInstanceOf(AlreadyServing);
  });

  it('refuses a malformed request rather than guessing', async () => {
    await expect(bridge.call({ conversation: '', calls: [read('c1', 'README.md')] }, 5000)).rejects.toThrow(/malformed/);
  });
});

describe('two sessions side by side', () => {
  let other: Serving;
  let otherFolder: string;

  beforeEach(async () => {
    otherFolder = join(base, 'Other Project');
    await mkdir(otherFolder);
    await writeFile(join(otherFolder, 'README.md'), '# other\n');
    other = await serve({ folder: otherFolder, approver, ports: PORTS, out: () => {}, env: env(), octopod: noOctopod });
  });

  afterEach(async () => {
    await other.close();
  });

  it('gives each its own port, code and state', () => {
    expect(other.session.stateDir).toBe(join(otherFolder, '.bushwhack'));
    expect(other.port).not.toBe(serving.port);
    expect(other.code).not.toBe(serving.code);
    expect(other.session.stateDir).not.toBe(serving.session.stateDir);
  });

  it('runs a call only in the session it was sent to, even with the same conversation and id', async () => {
    const otherBridge = await connectBridge({
      port: other.port,
      code: other.code,
      daemonNodeId: other.session.nodeId,
      nodeId: 'test-client-2',
      client: 'test',
    });
    try {
      const a = await bridge.call({ conversation: 'meta.ai/same', calls: [read('c1', 'README.md')] }, 5000);
      const b = await otherBridge.call({ conversation: 'meta.ai/same', calls: [read('c1', 'README.md')] }, 5000);
      expect(a.text).toContain('# demo');
      expect(b.text).toContain('# other');
      expect(b.summary[0].replay).toBe(false);
    } finally {
      otherBridge.close();
    }
  });

  it('does not let one session’s pairing code open the other', async () => {
    await expect(
      connectBridge({ port: other.port, code: serving.code, daemonNodeId: other.session.nodeId, nodeId: 'crossed', client: 'test' }),
    ).rejects.toThrow(/refused/);
  });
});

describe('secret files over the bridge', () => {
  const call = (id: string, tool: string, args: Record<string, string>): string =>
    ['---', `bushwhack: ${tool}`, `id: ${id}`, ...Object.entries(args).map(([k, v]) => `${k}: ${v}`), '---end'].join('\n');

  beforeEach(async () => {
    await mkdir(join(folder, 'app'), { recursive: true });
    await writeFile(join(folder, 'app', '.env'), 'STRIPE_KEY=sk_live_abcdef\n');
    await writeFile(join(folder, '.bushwhack', 'secrets.jsonc'), '{ "files": { "app/.env": { "format": "dotenv" } } }');
  });

  it('adds a value the operator types, and no value ever comes back — not even in the replay store', async () => {
    secretAnswer = 'pk_live_zyxwvu';
    const reply = await bridge.call({ conversation: 'meta.ai/s', calls: [call('s1', 'secret:add', { file: 'app/.env', name: 'PUBLIC_KEY' })] }, 5000);
    expect(reply.summary[0].status).toBe('ok');
    expect(await readFile(join(folder, 'app', '.env'), 'utf8')).toBe('STRIPE_KEY=sk_live_abcdef\nPUBLIC_KEY=pk_live_zyxwvu\n');

    const list = await bridge.call({ conversation: 'meta.ai/s', calls: [call('s2', 'secret:list', { file: 'app/.env' })] }, 5000);
    expect(list.text).toContain('STRIPE_KEY  set\nPUBLIC_KEY  set');

    const store = await readFile(join(folder, '.bushwhack', 'calls.jsonl'), 'utf8');
    for (const text of [reply.text, list.text, store]) {
      expect(text).not.toContain('sk_live_abcdef');
      expect(text).not.toContain('pk_live_zyxwvu');
    }
  });

  it('writes nothing when the operator gives no value', async () => {
    const reply = await bridge.call({ conversation: 'meta.ai/s', calls: [call('s1', 'secret:add', { file: 'app/.env', name: 'X_KEY' })] }, 5000);
    expect(reply.summary[0].status).toBe('denied');
    expect(await readFile(join(folder, 'app', '.env'), 'utf8')).toBe('STRIPE_KEY=sk_live_abcdef\n');
  });

  it('masks a declared value found in any other file the chat reads', async () => {
    await writeFile(join(folder, 'config.js'), "export const key = 'sk_live_abcdef';\n");
    const reply = await bridge.call({ conversation: 'meta.ai/s', calls: [read('r1', 'config.js')] }, 5000);
    expect(reply.text).toContain("export const key = '‹secret:STRIPE_KEY›';");
    expect(reply.text).not.toContain('sk_live_abcdef');
  });

  it('removes a variable only once approved', async () => {
    verdict = 'no';
    const denied = await bridge.call({ conversation: 'meta.ai/s', calls: [call('s1', 'secret:remove', { file: 'app/.env', name: 'STRIPE_KEY' })] }, 5000);
    expect(denied.summary[0].status).toBe('denied');
    verdict = 'yes';
    await bridge.call({ conversation: 'meta.ai/s', calls: [call('s2', 'secret:remove', { file: 'app/.env', name: 'STRIPE_KEY' })] }, 5000);
    expect(await readFile(join(folder, 'app', '.env'), 'utf8')).toBe('');
  });

  it('creates the declarations template on first serve, in the hidden state folder', async () => {
    const other = join(base, 'fresh');
    await mkdir(other);
    const s = await serve({ folder: other, approver, ports: PORTS, out: () => {}, env: env(), octopod: noOctopod });
    try {
      expect(await readFile(join(other, '.bushwhack', 'secrets.jsonc'), 'utf8')).toContain('"files"');
    } finally {
      await s.close();
    }
  });
});

describe('report:bug', () => {
  const report = (id: string, title: string, calls: string, body: string): string =>
    ['---', 'bushwhack: report:bug', `id: ${id}`, `title: ${JSON.stringify(title)}`, ...(calls ? [`calls: ${calls}`] : []), '---', body, '---end'].join('\n');

  it('keeps the report with the calls it names, tells the operator at once, and asks nothing', async () => {
    await mkdir(join(folder, 'app'), { recursive: true });
    await writeFile(join(folder, 'app', '.env'), 'STRIPE_KEY=sk_live_abcdef\n');
    await writeFile(join(folder, '.bushwhack', 'secrets.jsonc'), '{ "files": { "app/.env": { "format": "dotenv" } } }');
    await bridge.call({ conversation: 'meta.ai/r', calls: [read('r1', 'README.md')] }, 5000);
    const reply = await bridge.call({ conversation: 'meta.ai/r', calls: [report('b1', 'fs:read cut the file', 'r1, r9', 'It stopped early. The key sk_live_abcdef leaked?')] }, 5000);
    expect(reply.summary[0].status).toBe('ok');
    expect(asked).toEqual([]);
    expect(notices).toEqual(['🐞 fs:read cut the file']);
    const [kept] = await readReports(join(folder, '.bushwhack'));
    expect(kept).toEqual(expect.objectContaining({ conversation: 'meta.ai/r', id: 'b1', title: 'fs:read cut the file', version: VERSION }));
    // Masked like anything the chat gets; the calls named come with their results, as recorded.
    expect(kept.text).not.toContain('sk_live_abcdef');
    expect(kept.calls[0]).toEqual({ id: 'r1', result: expect.objectContaining({ tool: 'fs:read', status: 'ok', content: expect.stringContaining('# demo') }) });
    expect(kept.calls[1]).toEqual({ id: 'r9' });
  });

  it('takes a suggestion as well as a bug, and says which', async () => {
    const reply = await bridge.call({ conversation: 'meta.ai/s', calls: [['---', 'bushwhack: report:bug', 'id: s1', 'kind: suggestion', 'title: "an app:env tool"', '---', 'I had to guess which variables the app gets.', '---end'].join('\n')] }, 5000);
    expect(reply.summary[0].status).toBe('ok');
    expect(notices).toEqual(['💡 an app:env tool']);
    expect((await readReports(join(folder, '.bushwhack'))).at(-1)).toEqual(expect.objectContaining({ kind: 'suggestion', title: 'an app:env tool' }));
  });

  it('files at most so many reports per conversation', async () => {
    for (let i = 0; i < MAX_REPORTS_PER_CONVERSATION; i++) await bridge.call({ conversation: 'meta.ai/loop', calls: [report(`b${i}`, 'again', '', 'x')] }, 5000);
    const over = await bridge.call({ conversation: 'meta.ai/loop', calls: [report('b-over', 'again', '', 'x')] }, 5000);
    expect(over.summary[0].status).toBe('error');
    expect(over.text).toContain('the most it may');
    const other = await bridge.call({ conversation: 'meta.ai/other', calls: [report('b1', 'elsewhere', '', 'x')] }, 5000);
    expect(other.summary[0].status).toBe('ok');
  });
});

describe('ignore files, declaratively', () => {
  const call = (id: string, tool: string, args: Record<string, string>): string =>
    ['---', `bushwhack: ${tool}`, `id: ${id}`, ...Object.entries(args).map(([k, v]) => `${k}: ${v}`), '---end'].join('\n');

  it('adds a rule after approval — the file created if absent — and what it matches disappears', async () => {
    await rm(join(folder, '.gitignore'));
    await mkdir(join(folder, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(folder, 'node_modules', 'x', 'index.js'), 'x');
    expect((await bridge.call({ conversation: 'c', calls: [call('l1', 'fs:list', {})] }, 5000)).text).toContain('node_modules');
    const added = await bridge.call({ conversation: 'c', calls: [call('i1', 'ignore:add', { rule: 'node_modules/' })] }, 5000);
    expect(added.summary[0].status).toBe('ok');
    expect(asked).toContain('i1 ignore:add');
    expect(await readFile(join(folder, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    expect((await bridge.call({ conversation: 'c', calls: [call('l2', 'fs:list', {})] }, 5000)).text).not.toContain('node_modules');
    const again = await bridge.call({ conversation: 'c', calls: [call('i2', 'ignore:add', { rule: 'node_modules/' })] }, 5000);
    expect(again.text).toContain('already there');
    expect((await bridge.call({ conversation: 'c', calls: [call('i3', 'ignore:list', {})] }, 5000)).text).toContain('node_modules/');
  });

  it('never shows more: no negation, no comment, no writing the file itself, no link out', async () => {
    const before = await readFile(join(folder, '.gitignore'), 'utf8');
    const neg = await bridge.call({ conversation: 'c', calls: [call('n1', 'ignore:add', { rule: '"!.env"' })] }, 5000);
    expect(neg.summary[0].status).toBe('error');
    expect(neg.text).toContain('would show what another hides');
    const comment = await bridge.call({ conversation: 'c', calls: [call('n2', 'ignore:add', { rule: '"# note"' })] }, 5000);
    expect(comment.summary[0].status).toBe('error');
    const written = await bridge.call({ conversation: 'c', calls: [write('n3', '.gitignore', '')] }, 5000);
    expect(written.text).toContain('add a rule with ignore:add');
    expect(await readFile(join(folder, '.gitignore'), 'utf8')).toBe(before);
    // A .bushwhackignore that links out of the project is refused, both ways.
    await symlink(join(base, 'outside.txt'), join(folder, '.bushwhackignore'));
    await writeFile(join(base, 'outside.txt'), 'secret-rule\n');
    const linked = await bridge.call({ conversation: 'c', calls: [call('n4', 'ignore:list', { file: '.bushwhackignore' })] }, 5000);
    expect(linked.text).toContain('not a plain file');
    expect(linked.text).not.toContain('secret-rule');
  });
});
