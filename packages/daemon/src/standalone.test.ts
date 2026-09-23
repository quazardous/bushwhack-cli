/**
 * Standalone mode, end to end without a browser: chosen in the config, a real `serve`
 * gives the project a site of its files, tells the chat what it can build there, and never
 * asks octopod — not even when one is installed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectBridge, type BridgeClient } from './bridge-client.js';
import type { Approver } from './dispatcher.js';
import { configFile, readMode, writeMode } from './mode.js';
import type { OctopodClient } from './octopod-client.js';
import { serve, type Serving } from './serve.js';

let base: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bw-standalone-'));
  env = { XDG_STATE_HOME: join(base, 'state'), XDG_CONFIG_HOME: join(base, 'config') };
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('the mode', () => {
  it('is octopod unless setup chose standalone, and keeps the rest of the config', async () => {
    expect(await readMode(env)).toBe('octopod');
    await mkdir(join(base, 'config', 'bushwhack'), { recursive: true });
    await writeFile(configFile(env), '{"other":1,"mode":"weird"}');
    expect(await readMode(env)).toBe('octopod');
    await writeMode('standalone', env);
    expect(await readMode(env)).toBe('standalone');
    await writeMode('octopod', env);
    expect(await readMode(env)).toBe('octopod');
    await writeFile(configFile(env), 'not json');
    expect(await readMode(env)).toBe('octopod');
  });
});

describe('a project served standalone', () => {
  let serving: Serving;
  let bridge: BridgeClient;
  let octopodAsked: string[];

  const approver: Approver = { ask: async () => 'yes', secretValue: async () => undefined };

  beforeEach(async () => {
    await writeMode('standalone', env);
    const folder = join(base, 'Shop');
    await mkdir(folder);
    await writeFile(join(folder, 'index.html'), '<h1>v1</h1>');
    octopodAsked = [];
    // An octopod that answers everything: standalone must still not ask it.
    const octopod = new Proxy({}, { get: (_, key) => async () => (octopodAsked.push(String(key)), { ok: true, version: '9.9.9' }) }) as unknown as OctopodClient;
    serving = await serve({ folder, approver, ports: [19610, 19611], sitePorts: [19615, 19616], out: () => {}, env, octopod });
    bridge = await connectBridge({ port: serving.port, code: serving.code, daemonNodeId: serving.session.nodeId, nodeId: 'test-client', client: 'test' });
  });

  afterEach(async () => {
    bridge.close();
    await serving.close();
  });

  const site = (path: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: 19615, path, headers: { host: 'shop.localhost:19615' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += String(c)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });

  it('offers the page tools on its site, no app:* tools, and says what can be built there', async () => {
    const { manifest } = await bridge.list();
    expect(manifest).toContain('page:open');
    expect(manifest).not.toContain('app:create');
    expect(manifest).toContain('served at http://shop.localhost:19615/');
    expect(manifest).toMatch(/no server code, no database server/);
    expect(manifest).toMatch(/SQLite in the page through WebAssembly/);
    expect(octopodAsked).toEqual([]);
  });

  it('serves what the chat writes, at once', async () => {
    expect(await site('/')).toEqual({ status: 200, body: '<h1>v1</h1>' });
    const reply = await bridge.call({ conversation: 'c', calls: ['---\nbushwhack: fs:write\nid: w1\npath: index.html\n---\n<h1>v2</h1>\n---end'] }, 5000);
    expect(reply.text).toContain('status: ok');
    expect((await site('/')).body).toBe('<h1>v2</h1>\n');
  });
});
