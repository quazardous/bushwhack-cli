/**
 * The whole chain, for real: bushwhack → octopod's CLI → docker → the shared edge, with a
 * Node project served by its own dev script. Uses its own octopod instance (state, prefix,
 * port), so a real edge is never touched. Skipped without docker, or without octopod
 * (BUSHWHACK_OCTOPOD, or the octopod repository next to this one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectBridge, type BridgeClient } from './bridge-client.js';
import type { Approver } from './dispatcher.js';
import { octopodCli, octopodCommand } from './octopod-client.js';
import { serve, type Serving } from './serve.js';

const OCTOPOD_BIN = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../octopod/bin');
// Its clone's launcher: bin/octopod.js since 0.2, bin/octopod before.
const OCTOPOD = process.env.BUSHWHACK_OCTOPOD ?? [join(OCTOPOD_BIN, 'octopod.js'), join(OCTOPOD_BIN, 'octopod')].find((p) => existsSync(p)) ?? join(OCTOPOD_BIN, 'octopod.js');
const EDGE_PORT = 18490;

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function get(host: string): Promise<{ status: number; body: string }> {
  return new Promise((done) => {
    const req = request({ host: '127.0.0.1', port: EDGE_PORT, path: '/', headers: { Host: host }, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += String(c)));
      res.on('end', () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', () => done({ status: 0, body: '' }));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

const approver: Approver = { ask: async () => 'yes', secretValue: async () => undefined };

describe.skipIf(!dockerAvailable() || !existsSync(OCTOPOD))('the app, for real (docker + octopod)', { timeout: 600_000 }, () => {
  let base: string;
  let folder: string;
  let env: NodeJS.ProcessEnv;
  let serving: Serving;
  let bridge: BridgeClient;
  let n = 0;

  const run = async (tool: string, args: Record<string, string> = {}): Promise<string> => {
    const text = ['---', `bushwhack: ${tool}`, `id: i${++n}`, ...Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), '---end'].join('\n');
    return (await bridge.call({ conversation: 'it', calls: [text] }, 600_000)).text;
  };

  beforeAll(async () => {
    // A run killed before its cleanup leaves its edge holding the port: each run has octopod
    // state of its own, so it would not know that edge — and could not start its own.
    try {
      execFileSync('docker', ['rm', '-f', 'bwtest-edge'], { stdio: 'ignore' });
    } catch {
      // none left
    }
    base = await mkdtemp(join(tmpdir(), 'bw-app-it-'));
    folder = join(base, 'bwit-demo');
    await mkdir(join(folder, '.git'), { recursive: true });
    await writeFile(join(folder, 'package.json'), JSON.stringify({ name: 'bwit-demo', private: true, scripts: { dev: 'node server.js' } }));
    await writeFile(
      join(folder, 'server.js'),
      "require('http').createServer((q, r) => r.end('hello from the bushwhack app')).listen(Number(process.env.PORT), process.env.HOST);\n",
    );
    env = { ...process.env, OCTOPOD_STATE_DIR: join(base, 'octopod'), OCTOPOD_INSTANCE: 'bwtest', OCTOPOD_PORTS: String(EDGE_PORT) };
    serving = await serve({ folder, approver, ports: [19490, 19491], out: () => {}, env: { XDG_STATE_HOME: join(base, 'state') }, octopod: octopodCli(OCTOPOD, env) });
    bridge = await connectBridge({ port: serving.port, code: serving.code, daemonNodeId: serving.session.nodeId, nodeId: 'it', client: 'test' });
  }, 600_000);

  afterAll(async () => {
    await run('app:destroy').catch(() => undefined);
    bridge?.close();
    await serving?.close();
    try {
      const [command, before] = octopodCommand(OCTOPOD, env);
      execFileSync(command, [...before, 'edge', 'down'], { env, stdio: 'ignore' });
    } catch {
      // nothing up
    }
    await rm(base, { recursive: true, force: true });
  }, 600_000);

  it('creates the app and serves the project at <project>.localhost through the edge', async () => {
    const created = await run('app:create', { stack: 'node-app' });
    expect(created).toContain('status: ok');
    let answer = { status: 0, body: '' };
    for (let i = 0; i < 120 && answer.body !== 'hello from the bushwhack app'; i++) {
      answer = await get('bwit-demo.localhost');
      if (answer.body !== 'hello from the bushwhack app') await new Promise((r) => setTimeout(r, 500));
    }
    expect(answer).toEqual({ status: 200, body: 'hello from the bushwhack app' });
  });

  it('hides .bushwhack/ from the app, even though it is in the project', async () => {
    expect(await stat(join(folder, '.bushwhack', 'pairing.json')).then(() => true)).toBe(true);
    const out = await run('app:exec', { command: 'ls -A /app/.bushwhack | wc -l' });
    expect(out).toMatch(/\n0\n/);
  });

  it('keeps .git/ read-only for the app — no hook can be planted', async () => {
    const out = await run('app:exec', { command: 'touch /app/.git/hooks-test' });
    expect(out).toContain('status: error');
    expect(out).toMatch(/Read-only file system/i);
  });

  it('writes the project files as the operator', async () => {
    await run('app:exec', { command: 'touch /app/made-by-the-app' });
    const made = await stat(join(folder, 'made-by-the-app'));
    // Windows has no uids: that it reached the project is what can be checked there.
    if (process.platform !== 'win32') expect(made.uid).toBe(process.getuid?.());
  });

  it('has no way out to the internet unless the operator approved one', async () => {
    const out = await run('app:exec', {
      command: `node -e "require('http').get('http://1.1.1.1', () => console.log('out')).on('error', () => console.log('blocked')).setTimeout(3000, function () { this.destroy(); })"`,
    });
    expect(out).toContain('blocked');
    expect(out).not.toMatch(/\nout\n/);
  });

  it('runs as a user named after the project, with a home of its own', async () => {
    const out = await run('app:exec', { command: 'id -un; echo "$HOME"' });
    expect(out).toContain('bwit-demo\n/home/bwit-demo');
  });

  it('reports status and logs', async () => {
    expect(await run('app:status')).toContain('running at http://bwit-demo.localhost:18490');
    expect(await run('app:logs', { lines: '20' })).toContain('node server.js');
  });

  it('destroys the app and leaves the project', async () => {
    expect(await run('app:destroy')).toContain('the project files are untouched');
    expect(await stat(join(folder, 'server.js')).then(() => true)).toBe(true);
    const left = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' });
    expect(left).not.toMatch(/bwit-demo-app/);
  });
});
