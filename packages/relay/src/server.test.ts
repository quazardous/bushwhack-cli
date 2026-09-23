/**
 * Relay HTTP introspection (#2521).
 *
 * An extension registers under its own node id, never under the literal
 * nodeId 'extension'. `/health` used to look that literal up and reported
 * `extension:false` with a live, serving extension connected — and `/clients`
 * showed it as `type: unknown` because registration dropped the declared client kind.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WebSocket } from 'ws';
import { RelayServer } from './server.js';
import { connectClient, wait } from './test-client.js';

const TEST_PORT = 19457;
const EXTENSION_NODE_ID = 'ext-one';
const EXTENSION_REGISTRATION = {
  client: 'extension',
  botName: 'Bushwhack bridge',
  fingerprint: 'fp-test',
  extensionId: 'ext-test',
  extensionVersion: '0.6.3',
  taskTypes: ['explore:navigate', 'leboncoin:parse-search'],
};

async function getJson(path: string): Promise<any> {
  const response = await fetch(`http://localhost:${TEST_PORT}${path}`);
  return response.json();
}

describe('RelayServer HTTP introspection', () => {
  let logDir: string;
  let server: RelayServer;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    logDir = mkdtempSync(join(tmpdir(), 'bushwhack-relay-test-'));
    server = new RelayServer({ port: TEST_PORT, logDir, version: 'test' });
    await server.listen();
  });

  afterEach(async () => {
    sockets.splice(0).forEach((ws) => ws.close());
    await server.close();
    rmSync(logDir, { recursive: true, force: true });
  });

  async function register(nodeId: string, metadata: Record<string, unknown>) {
    const client = await connectClient(TEST_PORT, nodeId, [], metadata);
    sockets.push(client.ws);
    return client;
  }

  it('/health finds an extension registered under its bot identity', async () => {
    await register('mcp:default', {});
    await register(EXTENSION_NODE_ID, EXTENSION_REGISTRATION);

    const health = await getJson('/health');

    expect(health.extension).toBe(true);
    expect(health.extensionVersion).toBe('0.6.3');
    expect(health.taskTypes).toEqual(EXTENSION_REGISTRATION.taskTypes);
    expect(health.connectedAt).not.toBeNull();
  });

  it('/health reports no extension when only non-extension clients are connected', async () => {
    await register('mcp:default', { client: 'mcp' });

    const health = await getJson('/health');

    expect(health.clients).toBe(1);
    expect(health.extension).toBe(false);
    expect(health.taskTypes).toEqual([]);
  });

  it('/clients keeps the client kind, name and fingerprint declared at registration', async () => {
    await register(EXTENSION_NODE_ID, EXTENSION_REGISTRATION);

    const { clients } = await getJson('/clients');

    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({
      nodeId: EXTENSION_NODE_ID,
      type: 'extension',
      name: 'Bushwhack bridge',
      fingerprint: 'fp-test',
      extensionId: 'ext-test',
      version: '0.6.3',
    });
  });
});

describe('RelayServer pairing', () => {
  const PORT = 19458;
  let logDir: string;
  let server: RelayServer;

  beforeEach(async () => {
    logDir = mkdtempSync(join(tmpdir(), 'bushwhack-relay-key-'));
    server = new RelayServer({ port: PORT, logDir, version: 'test', securityKey: 'K-123', quiet: true, health: { service: 'bushwhack', session: 'demo' } });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    rmSync(logDir, { recursive: true, force: true });
  });

  it('refuses a client without the pairing code', async () => {
    await expect(connectClient(PORT, 'intruder')).rejects.toThrow();
  });

  it('refuses a client with a wrong pairing code', async () => {
    await expect(connectClient(PORT, 'intruder', [], { securityKey: 'K-124' })).rejects.toThrow();
  });

  it('accepts the right code, and routes between paired clients', async () => {
    const daemon = await connectClient(PORT, 'daemon', [], { securityKey: 'K-123' });
    const ext = await connectClient(PORT, 'ext', [], { securityKey: 'K-123' });
    ext.ws.send(JSON.stringify({ id: 'm1', type: 'tools:list', payload: {}, source: 'ext', target: 'daemon', scope: 'global', timestamp: 0 }));
    await wait(100);
    expect(daemon.messages.map((m) => m.type)).toContain('tools:list');
    daemon.ws.close();
    ext.ws.close();
  });

  it('refuses a second client taking a name already connected: nobody poses as the service', async () => {
    const service = await connectClient(PORT, 'service:bushwhack', [], { securityKey: 'K-123' });
    await expect(connectClient(PORT, 'service:bushwhack', [], { securityKey: 'K-123' })).rejects.toThrow();
    const ext = await connectClient(PORT, 'ext:abc', [], { securityKey: 'K-123' });
    ext.ws.send(JSON.stringify({ id: 'm2', type: 'chat:send', payload: {}, source: 'ext:abc', target: 'service:bushwhack', scope: 'global', timestamp: 0 }));
    await wait(100);
    expect(service.messages.map((m) => m.id)).toContain('m2');
    service.ws.close();
    ext.ws.close();
  });

  it('lets the extension come back under its own name, its old socket stale', async () => {
    const first = await connectClient(PORT, 'ext:abc', [], { securityKey: 'K-123' });
    const second = await connectClient(PORT, 'ext:abc', [], { securityKey: 'K-123' });
    await wait(50);
    expect(second.ws.readyState).toBe(second.ws.OPEN);
    first.ws.close();
    second.ws.close();
  });

  it('drops an envelope sent before registering, instead of routing it', async () => {
    const daemon = await connectClient(PORT, 'daemon', [], { securityKey: 'K-123' });
    const { WebSocket } = await import('ws');
    const sneaky = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((resolve) => sneaky.on('open', resolve));
    sneaky.send(JSON.stringify({ id: 'x1', type: 'tools:call', payload: {}, source: 'sneaky', target: 'daemon', scope: 'global', timestamp: 0 }));
    await wait(150);
    expect(daemon.messages.map((m) => m.id)).not.toContain('x1');
    daemon.ws.close();
  });

  it('says whose relay it is on /health, with no CORS header for web pages', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'bushwhack', session: 'demo' });
  });

  it('rejects listen on a taken port', async () => {
    const second = new RelayServer({ port: PORT, logDir, version: 'test', quiet: true });
    await expect(second.listen()).rejects.toThrow(/EADDRINUSE/);
  });
});
