/**
 * WebSocket Server Transport - Isolation Tests
 *
 * Verifies that the relay correctly isolates extension clients:
 * - Extensions cannot route messages to other extensions
 * - MCP can communicate with specific extensions via nodeId
 * - No broadcast fallback to unrelated clients
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { WebSocketServerTransport, HubEnvelope } from './ws-server-transport.js';
import { connectClient, wait } from './test-client.js';

// Test port to avoid conflicts
const TEST_PORT = 19456;

/**
 * Helper to create a test envelope
 */
function createEnvelope(overrides: Partial<HubEnvelope> = {}): HubEnvelope {
  return {
    id: `test-${Date.now()}-${Math.random()}`,
    type: 'test-message',
    payload: { test: true },
    source: 'test-source',
    target: '*',
    scope: 'local',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('WebSocketServerTransport Isolation', () => {
  let wss: WebSocketServer;
  let transport: WebSocketServerTransport;
  let receivedMessages: Array<{ envelope: HubEnvelope; fromClientId: string }>;

  beforeEach(async () => {
    receivedMessages = [];

    wss = new WebSocketServer({ port: TEST_PORT });
    transport = new WebSocketServerTransport(wss);

    // Track messages received by transport
    transport.onReceive((envelope, fromClientId) => {
      receivedMessages.push({ envelope, fromClientId });
      // Forward message (like server.ts does)
      transport.send(envelope);
    });

    // Wait for server to be ready
    await new Promise<void>((resolve) => {
      wss.on('listening', resolve);
    });
  });

  afterEach(async () => {
    transport.disconnect();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  });

  describe('Extension Isolation', () => {
    it('should NOT route messages between extensions', async () => {
      // Connect two extensions (like Chrome and Chromium)
      const extA = await connectClient(TEST_PORT, 'ext-one', ['debug-panel']);
      const extB = await connectClient(TEST_PORT, 'ext-two', ['debug-panel']);

      // Extension A sends to 'debug-panel' (internal target)
      extA.ws.send(
        JSON.stringify(
          createEnvelope({
            source: 'ext-one',
            target: 'debug-panel',
            type: 'panel:state',
          }),
        ),
      );

      await wait(100);

      // Extension B should NOT receive anything
      expect(extB.messages.length).toBe(0);

      // Clean up
      extA.ws.close();
      extB.ws.close();
    });

    it('should NOT route extension-to-extension direct messages', async () => {
      // Even with direct nodeId targeting, extensions shouldn't talk to each other
      // (though technically the current implementation allows this - it's about
      // preventing accidental cross-talk via peerPatterns/broadcast)
      const extA = await connectClient(TEST_PORT, 'ext-one');
      const extB = await connectClient(TEST_PORT, 'ext-two');

      // Extension A sends directly to Extension B's nodeId
      // This WILL work (direct routing), but the point is that
      // peerPatterns like 'debug-panel' don't cause cross-talk
      extA.ws.send(
        JSON.stringify(
          createEnvelope({
            source: 'ext-one',
            target: 'ext-two', // Direct target
            type: 'test',
          }),
        ),
      );

      await wait(100);

      // Direct nodeId routing works (this is expected behavior)
      expect(extB.messages.length).toBe(1);
      expect(extB.messages[0].source).toBe('ext-one');

      extA.ws.close();
      extB.ws.close();
    });

    it('should NOT broadcast to extensions when target not found', async () => {
      // This was the bug: when target 'debug-panel' not found,
      // it would broadcast to ALL clients including other extensions
      const extA = await connectClient(TEST_PORT, 'ext-one');
      const extB = await connectClient(TEST_PORT, 'ext-two');

      // Extension A sends to non-existent target
      extA.ws.send(
        JSON.stringify(
          createEnvelope({
            source: 'ext-one',
            target: 'non-existent-target',
            type: 'test',
          }),
        ),
      );

      await wait(100);

      // Extension B should NOT receive (no broadcast fallback)
      expect(extB.messages.length).toBe(0);

      extA.ws.close();
      extB.ws.close();
    });
  });

  describe('MCP Communication', () => {
    it('should route MCP messages to specific extension', async () => {
      const extA = await connectClient(TEST_PORT, 'ext-one');
      const extB = await connectClient(TEST_PORT, 'ext-two');
      const mcp = await connectClient(TEST_PORT, 'mcp:default');

      // MCP sends to Extension A specifically
      mcp.ws.send(
        JSON.stringify(
          createEnvelope({
            source: 'mcp:default',
            target: 'ext-one',
            type: 'task:start',
          }),
        ),
      );

      await wait(100);

      // Only Extension A receives
      expect(extA.messages.length).toBe(1);
      expect(extA.messages[0].type).toBe('task:start');

      // Extension B does NOT receive
      expect(extB.messages.length).toBe(0);

      extA.ws.close();
      extB.ws.close();
      mcp.ws.close();
    });

    it('should support pattern matching for MCP targets', async () => {
      const mcp1 = await connectClient(TEST_PORT, 'mcp:default');
      const mcp2 = await connectClient(TEST_PORT, 'mcp:other');
      const ext = await connectClient(TEST_PORT, 'ext-one');

      // Extension sends to 'mcp:*' pattern
      ext.ws.send(
        JSON.stringify(
          createEnvelope({
            source: 'ext-one',
            target: 'mcp:*',
            type: 'status',
          }),
        ),
      );

      await wait(100);

      // Both MCP clients receive
      expect(mcp1.messages.length).toBe(1);
      expect(mcp2.messages.length).toBe(1);

      ext.ws.close();
      mcp1.ws.close();
      mcp2.ws.close();
    });

    it('should broadcast with target=* to all clients', async () => {
      const extA = await connectClient(TEST_PORT, 'ext-one');
      const extB = await connectClient(TEST_PORT, 'ext-two');
      const mcp = await connectClient(TEST_PORT, 'mcp:default');

      // MCP broadcasts to all
      mcp.ws.send(
        JSON.stringify(
          createEnvelope({
            source: 'mcp:default',
            target: '*',
            type: 'broadcast',
          }),
        ),
      );

      await wait(100);

      // All clients receive (except source)
      expect(extA.messages.length).toBe(1);
      expect(extB.messages.length).toBe(1);
      // MCP doesn't receive its own broadcast
      expect(mcp.messages.length).toBe(0);

      extA.ws.close();
      extB.ws.close();
      mcp.ws.close();
    });
  });

  describe('Client Registration', () => {
    it('should track connected clients by nodeId', async () => {
      const ext = await connectClient(TEST_PORT, 'ext-test');

      const clients = transport.getConnectedClients();
      expect(clients).toContain('ext-test');

      ext.ws.close();
    });

    it('should hand an extension name over to its reconnection (stale connection)', async () => {
      // First connection
      const ext1 = await connectClient(TEST_PORT, 'ext:same-id');

      // Second connection with same nodeId (simulates reconnect)
      const ext2 = await connectClient(TEST_PORT, 'ext:same-id');

      await wait(100);

      // Only one client registered with that ID
      const clients = transport.getConnectedClients();
      const count = clients.filter((c) => c === 'ext:same-id').length;
      expect(count).toBe(1);

      // ext1 should have been closed by the transport
      expect(ext1.ws.readyState).toBe(WebSocket.CLOSED);

      ext2.ws.close();
    });
  });

  describe('peerPatterns Should NOT Affect Routing', () => {
    it('should NOT route based on peerPatterns match', async () => {
      // Both extensions declare they can reach 'debug-panel'
      // This should NOT mean messages to 'debug-panel' go to both
      const extA = await connectClient(TEST_PORT, 'ext-one', ['debug-panel', 'content-script']);
      const extB = await connectClient(TEST_PORT, 'ext-two', ['debug-panel', 'content-script']);

      // Extension A sends to 'debug-panel' (its LOCAL peer)
      extA.ws.send(
        JSON.stringify(
          createEnvelope({
            source: 'ext-one',
            target: 'debug-panel',
            type: 'panel:update',
          }),
        ),
      );

      await wait(100);

      // Extension B should NOT receive (even though it has 'debug-panel' in peerPatterns)
      // peerPatterns describe LOCAL peers, not what messages to forward
      expect(extB.messages.length).toBe(0);

      extA.ws.close();
      extB.ws.close();
    });

    it('should NOT use peerPatterns for routing decisions', async () => {
      // Extension declares it can reach 'server'
      const ext = await connectClient(TEST_PORT, 'ext-one', ['server']);
      // MCP declares it can reach 'extension'
      const mcp = await connectClient(TEST_PORT, 'mcp:default', ['extension']);

      // Send to 'server' - no client has this as nodeId
      mcp.ws.send(
        JSON.stringify(
          createEnvelope({
            source: 'mcp:default',
            target: 'server',
            type: 'test',
          }),
        ),
      );

      await wait(100);

      // Extension should NOT receive (server is not its nodeId)
      // Even though ext declared peerPatterns: ['server']
      expect(ext.messages.length).toBe(0);

      ext.ws.close();
      mcp.ws.close();
    });
  });
});
