/**
 * Hub Network Tests
 *
 * Tests the new VLAN-based routing model where:
 * - Transport is a dumb pipe (no VLAN config)
 * - Hub owns VLAN routing configuration
 * - Monitor transports receive all traffic (parasites)
 * - Hops tracing for debugging
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HubNode } from './hub-node.js';
import { MemoryTransport, createLinkedPair } from './memory-transport.js';
import { BusTransport } from './bus-transport.js';
import { HubEnvelope } from './types.js';

// Helper to wait for async message delivery
const tick = () => new Promise((r) => setTimeout(r, 0));
const ticks = (n: number) => Promise.all(Array(n).fill(0).map(() => tick()));

describe('Hub Network', () => {
  describe('HubNode Basics', () => {
    it('should create a hub node with nodeId', () => {
      const node = new HubNode({ nodeId: 'test-node' });
      expect(node.nodeId).toBe('test-node');
    });

    it('should emit and receive messages locally', () => {
      const node = new HubNode({ nodeId: 'test-node' });
      const received: HubEnvelope[] = [];

      node.on('test', (payload, envelope) => {
        received.push(envelope);
      });

      node.emit('test', { data: 123 });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('test');
      expect(received[0].payload.data).toBe(123);
      expect(received[0].source).toBe('test-node');
    });

    it('should include hops in emitted envelope', () => {
      const node = new HubNode({ nodeId: 'test-node' });
      const received: HubEnvelope[] = [];

      node.on('test', (_, envelope) => received.push(envelope));
      node.emit('test', {});

      expect(received[0].hops).toHaveLength(1);
      expect(received[0].hops![0].node).toBe('test-node');
      expect(received[0].hops![0].transport).toBeUndefined(); // origin has no transport
    });

    it('should deduplicate messages', () => {
      const node = new HubNode({ nodeId: 'test-node' });
      const received: HubEnvelope[] = [];

      node.on('test', (_, envelope) => received.push(envelope));

      const envelope = node.emit('test', {});

      // Try to receive the same message again (simulating loop)
      node.receive(null, envelope);
      node.receive(null, envelope);

      expect(received).toHaveLength(1);
    });

    it('should support local monitors for debugging', () => {
      const node = new HubNode({ nodeId: 'test-node' });
      const monitored: HubEnvelope[] = [];

      node.monitor((envelope) => monitored.push(envelope));

      node.emit('type-a', {});
      node.emit('type-b', {});

      expect(monitored).toHaveLength(2);
      expect(monitored[0].type).toBe('type-a');
      expect(monitored[1].type).toBe('type-b');
    });
  });

  describe('Transport Basics', () => {
    it('should create linked transport pair', async () => {
      const [tA, tB] = createLinkedPair('node-a', 'node-b');

      await tA.connect();
      await tB.connect();

      const receivedByB: HubEnvelope[] = [];
      tB.onReceive((env) => receivedByB.push(env));

      const envelope: HubEnvelope = {
        id: 'msg-1',
        type: 'test',
        payload: {},
        source: 'a',
        target: '*',
        scope: 'global',
        timestamp: Date.now(),
      };

      tA.send(envelope);
      await tick();

      expect(receivedByB).toHaveLength(1);
      expect(receivedByB[0].id).toBe('msg-1');
    });

    it('should not send when disconnected', async () => {
      const [tA, tB] = createLinkedPair('node-a', 'node-b');

      // Don't connect tA
      await tB.connect();

      const receivedByB: HubEnvelope[] = [];
      tB.onReceive((env) => receivedByB.push(env));

      tA.send({
        id: 'msg-1',
        type: 'test',
        payload: {},
        source: 'a',
        target: '*',
        scope: 'global',
        timestamp: Date.now(),
      });

      await tick();

      expect(receivedByB).toHaveLength(0);
    });
  });

  describe('Two Node Communication', () => {
    it('should forward messages between two nodes', async () => {
      const nodeA = new HubNode({ nodeId: 'node-a' });
      const nodeB = new HubNode({ nodeId: 'node-b' });

      const [tA, tB] = createLinkedPair('to-b', 'to-a', ['node-b'], ['node-a']);
      await tA.connect();
      await tB.connect();

      nodeA.addTransport(tA);
      nodeB.addTransport(tB);

      const receivedByB: HubEnvelope[] = [];
      nodeB.on('hello', (_, env) => receivedByB.push(env));

      nodeA.emit('hello', { msg: 'hi' });
      await tick();

      expect(receivedByB).toHaveLength(1);
      expect(receivedByB[0].source).toBe('node-a');
      expect(receivedByB[0].payload.msg).toBe('hi');
    });

    it('should track hops through nodes', async () => {
      const nodeA = new HubNode({ nodeId: 'node-a' });
      const nodeB = new HubNode({ nodeId: 'node-b' });

      const [tA, tB] = createLinkedPair('to-b', 'to-a', ['node-b'], ['node-a']);
      await tA.connect();
      await tB.connect();

      nodeA.addTransport(tA);
      nodeB.addTransport(tB);

      const receivedByB: HubEnvelope[] = [];
      nodeB.on('test', (_, env) => receivedByB.push(env));

      nodeA.emit('test', {});
      await tick();

      expect(receivedByB[0].hops).toHaveLength(2);
      expect(receivedByB[0].hops![0]).toEqual({ node: 'node-a' }); // origin
      expect(receivedByB[0].hops![1]).toEqual({ node: 'node-b', transport: 'to-a' }); // via transport
    });

    it('should apply no-return rule', async () => {
      const nodeA = new HubNode({ nodeId: 'node-a' });
      const nodeB = new HubNode({ nodeId: 'node-b' });

      const [tA, tB] = createLinkedPair('to-b', 'to-a', ['node-b'], ['node-a']);
      await tA.connect();
      await tB.connect();

      nodeA.addTransport(tA);
      nodeB.addTransport(tB);

      const sentByA: HubEnvelope[] = [];
      const originalSend = tA.send.bind(tA);
      tA.send = (env) => {
        sentByA.push(env);
        originalSend(env);
      };

      const receivedByB: HubEnvelope[] = [];
      nodeB.on('test', (_, env) => receivedByB.push(env));

      nodeA.emit('test', {});
      await tick();

      expect(receivedByB).toHaveLength(1);
      expect(sentByA).toHaveLength(1); // Only A's original send, no loop back
    });
  });

  describe('VLAN Routing', () => {
    it('should forward scope=local to same VLAN transports', async () => {
      const hub = new HubNode({ nodeId: 'hub', defaultVlan: 'internal' });
      const nodeA = new HubNode({ nodeId: 'node-a' });
      const nodeB = new HubNode({ nodeId: 'node-b' });

      const [tInternal, tInternalPeer] = createLinkedPair('internal', 'to-hub', ['node-a'], ['hub']);
      const [tExternal, tExternalPeer] = createLinkedPair('external', 'to-hub', ['node-b'], ['hub']);

      await tInternal.connect();
      await tInternalPeer.connect();
      await tExternal.connect();
      await tExternalPeer.connect();

      // Internal transport on 'internal' VLAN
      hub.addTransport(tInternal, { vlan: 'internal' });
      // External transport on no VLAN
      hub.addTransport(tExternal);

      nodeA.addTransport(tInternalPeer);
      nodeB.addTransport(tExternalPeer);

      const receivedByA: HubEnvelope[] = [];
      const receivedByB: HubEnvelope[] = [];

      nodeA.on('local-msg', (_, env) => receivedByA.push(env));
      nodeB.on('local-msg', (_, env) => receivedByB.push(env));

      // Emit with scope='local' - should only go to VLAN 'internal'
      hub.emit('local-msg', { data: 1 }, { scope: 'local' });
      await tick();

      expect(receivedByA).toHaveLength(1); // Same VLAN
      expect(receivedByB).toHaveLength(0); // Different VLAN (no VLAN assigned)
    });

    it('should allow explicit VLAN in emit', async () => {
      const hub = new HubNode({ nodeId: 'hub', vlans: ['vlan-a', 'vlan-b'], defaultVlan: 'vlan-a' });

      const [tA, tAPeer] = createLinkedPair('to-a', 'from-hub', ['node-a'], ['hub']);
      const [tB, tBPeer] = createLinkedPair('to-b', 'from-hub', ['node-b'], ['hub']);

      await tA.connect();
      await tAPeer.connect();
      await tB.connect();
      await tBPeer.connect();

      hub.addTransport(tA, { vlan: 'vlan-a' });
      hub.addTransport(tB, { vlan: 'vlan-b' });

      const nodeA = new HubNode({ nodeId: 'node-a' });
      const nodeB = new HubNode({ nodeId: 'node-b' });

      nodeA.addTransport(tAPeer);
      nodeB.addTransport(tBPeer);

      const receivedByA: HubEnvelope[] = [];
      const receivedByB: HubEnvelope[] = [];

      nodeA.on('test', (_, env) => receivedByA.push(env));
      nodeB.on('test', (_, env) => receivedByB.push(env));

      // Emit to vlan-b explicitly (not defaultVlan)
      hub.emit('test', {}, { scope: 'local', vlan: 'vlan-b' });
      await tick();

      expect(receivedByA).toHaveLength(0); // vlan-a
      expect(receivedByB).toHaveLength(1); // vlan-b
    });

    it('should treat no VLAN as single global LAN for scope=local', async () => {
      const nodeA = new HubNode({ nodeId: 'node-a' });
      const nodeB = new HubNode({ nodeId: 'node-b' });

      // No VLAN configured anywhere
      const [tA, tB] = createLinkedPair('to-b', 'to-a', ['node-b'], ['node-a']);
      await tA.connect();
      await tB.connect();

      nodeA.addTransport(tA); // No vlan option
      nodeB.addTransport(tB);

      const receivedByB: HubEnvelope[] = [];
      nodeB.on('test', (_, env) => receivedByB.push(env));

      // scope='local' but no VLAN = single global LAN
      nodeA.emit('test', {}, { scope: 'local' });
      await tick();

      expect(receivedByB).toHaveLength(1);
    });

    it('should include vlan in envelope for scope=local', () => {
      const node = new HubNode({ nodeId: 'test', defaultVlan: 'my-vlan' });
      const received: HubEnvelope[] = [];

      node.on('test', (_, env) => received.push(env));
      node.emit('test', {}, { scope: 'local' });

      expect(received[0].vlan).toBe('my-vlan');
    });
  });

  describe('Monitor Transports (Parasites)', () => {
    it('should forward all messages to monitor transports', async () => {
      const hub = new HubNode({ nodeId: 'hub', defaultVlan: 'internal' });

      const [tInternal, tInternalPeer] = createLinkedPair('internal', 'to-hub', [], []);
      const [tMonitor, tMonitorPeer] = createLinkedPair('monitor', 'to-hub', [], []);

      await tInternal.connect();
      await tInternalPeer.connect();
      await tMonitor.connect();
      await tMonitorPeer.connect();

      hub.addTransport(tInternal, { vlan: 'internal' });
      hub.addTransport(tMonitor, { monitor: true }); // Parasite

      const nodeInternal = new HubNode({ nodeId: 'internal-node' });
      const nodeMonitor = new HubNode({ nodeId: 'monitor-node' });

      nodeInternal.addTransport(tInternalPeer);
      nodeMonitor.addTransport(tMonitorPeer);

      const receivedByInternal: HubEnvelope[] = [];
      const receivedByMonitor: HubEnvelope[] = [];

      nodeInternal.on('test', (_, env) => receivedByInternal.push(env));
      nodeMonitor.on('test', (_, env) => receivedByMonitor.push(env));

      // Emit scope='local' (VLAN 'internal')
      hub.emit('test', {}, { scope: 'local' });
      await tick();

      // Internal gets it (same VLAN)
      expect(receivedByInternal).toHaveLength(1);
      // Monitor also gets it (parasite sees everything)
      expect(receivedByMonitor).toHaveLength(1);
    });

    it('should not send back to monitor on no-return rule', async () => {
      const hub = new HubNode({ nodeId: 'hub' });

      const [tMonitor, tMonitorPeer] = createLinkedPair('monitor', 'to-hub', [], []);
      await tMonitor.connect();
      await tMonitorPeer.connect();

      hub.addTransport(tMonitor, { monitor: true });

      const monitorNode = new HubNode({ nodeId: 'monitor-node' });
      monitorNode.addTransport(tMonitorPeer);

      const sentToMonitor: HubEnvelope[] = [];
      const origSend = tMonitor.send.bind(tMonitor);
      tMonitor.send = (env) => {
        sentToMonitor.push(env);
        origSend(env);
      };

      // Monitor sends a message to hub
      monitorNode.emit('from-monitor', {});
      await tick();

      // Hub should NOT send back to monitor (no-return rule)
      expect(sentToMonitor).toHaveLength(0);
    });
  });

  describe('Smart Routing', () => {
    it('should route to specific transport based on target pattern', async () => {
      const hub = new HubNode({ nodeId: 'hub' });

      const [tRelay, tRelayPeer] = createLinkedPair('relay', 'hub', ['mcp:*'], ['hub']);
      const [tRuntime, tRuntimePeer] = createLinkedPair('runtime', 'hub', ['panel:*'], ['hub']);

      await tRelay.connect();
      await tRelayPeer.connect();
      await tRuntime.connect();
      await tRuntimePeer.connect();

      hub.addTransport(tRelay);
      hub.addTransport(tRuntime);

      const sentToRelay: HubEnvelope[] = [];
      const sentToRuntime: HubEnvelope[] = [];

      tRelay.send = (env) => sentToRelay.push(env);
      tRuntime.send = (env) => sentToRuntime.push(env);

      // Message to mcp:default should go to relay only
      hub.emit('pong', {}, { target: 'mcp:default' });
      await tick();

      expect(sentToRelay).toHaveLength(1);
      expect(sentToRuntime).toHaveLength(0);

      // Reset
      sentToRelay.length = 0;
      sentToRuntime.length = 0;

      // Message to panel:debug should go to runtime only
      hub.emit('state', {}, { target: 'panel:debug' });
      await tick();

      expect(sentToRelay).toHaveLength(0);
      expect(sentToRuntime).toHaveLength(1);
    });

    it('should broadcast unknown targets to all transports', async () => {
      const hub = new HubNode({ nodeId: 'hub' });

      const [tA, _] = createLinkedPair('transport-a', 'peer-a', ['known:*'], []);
      const [tB, __] = createLinkedPair('transport-b', 'peer-b', ['other:*'], []);

      await tA.connect();
      await tB.connect();

      hub.addTransport(tA);
      hub.addTransport(tB);

      const sentToA: HubEnvelope[] = [];
      const sentToB: HubEnvelope[] = [];

      tA.send = (env) => sentToA.push(env);
      tB.send = (env) => sentToB.push(env);

      // Unknown target: broadcast to all
      hub.emit('msg', {}, { target: 'unknown:client' });
      await tick();

      expect(sentToA).toHaveLength(1);
      expect(sentToB).toHaveLength(1);
    });
  });

  describe('Full Topology Simulation', () => {
    /**
     * Topology:
     *
     *    ┌───────┐         ┌──────────┐         ┌───────────┐
     *    │  MCP  │◄───────►│  RELAY   │◄───────►│ EXTENSION │◄────► SKYNET
     *    └───────┘         │ (monitor)│         └─────┬─────┘
     *                      └──────────┘               │ vlan:extension
     *                                    ┌────────────┼────────────┐
     *                                    │            │            │
     *                              ┌─────┴─────┐ ┌────┴────┐ ┌─────┴─────┐
     *                              │   DEBUG   │ │ CONTENT │ │  POPUP    │
     *                              │   PANEL   │ │ SCRIPT  │ │           │
     *                              └───────────┘ └─────────┘ └───────────┘
     */
    let server: HubNode;
    let relay: HubNode;
    let extension: HubNode;
    let mcp: HubNode;
    let debugPanel: HubNode;
    let contentScript: HubNode;

    beforeEach(async () => {
      // Create nodes
      server = new HubNode({ nodeId: 'server' });
      relay = new HubNode({ nodeId: 'relay' });
      extension = new HubNode({ nodeId: 'extension', vlans: ['extension'], defaultVlan: 'extension' });
      mcp = new HubNode({ nodeId: 'mcp:default' });
      debugPanel = new HubNode({ nodeId: 'debug-panel' });
      contentScript = new HubNode({ nodeId: 'content:tab-1' });

      // Server ↔ Extension (external, no VLAN)
      const [tServerToExt, tExtToServer] = createLinkedPair(
        'to-extension', 'to-server',
        ['extension', 'debug-panel', 'content:*'],
        ['server:*'],
      );
      await tServerToExt.connect();
      await tExtToServer.connect();
      server.addTransport(tServerToExt);
      extension.addTransport(tExtToServer); // No VLAN = external

      // Extension ↔ Relay (external, relay is monitor)
      const [tExtToRelay, tRelayToExt] = createLinkedPair(
        'to-relay', 'to-extension',
        ['mcp:*', 'relay'],
        ['extension', 'server:*', 'debug-panel', 'content:*'],
      );
      await tExtToRelay.connect();
      await tRelayToExt.connect();
      extension.addTransport(tExtToRelay, { monitor: true }); // Relay sees all for debug
      relay.addTransport(tRelayToExt);

      // MCP ↔ Relay (external)
      const [tMcpToRelay, tRelayToMcp] = createLinkedPair(
        'to-relay', 'to-mcp',
        ['relay', 'extension', 'server:*'],
        ['mcp:*'],
      );
      await tMcpToRelay.connect();
      await tRelayToMcp.connect();
      mcp.addTransport(tMcpToRelay);
      relay.addTransport(tRelayToMcp);

      // Extension ↔ Debug Panel (VLAN 'extension')
      const [tExtToPanel, tPanelToExt] = createLinkedPair(
        'runtime-panel', 'runtime',
        ['debug-panel'],
        ['extension', 'server:*', 'mcp:*'],
      );
      await tExtToPanel.connect();
      await tPanelToExt.connect();
      extension.addTransport(tExtToPanel, { vlan: 'extension' });
      debugPanel.addTransport(tPanelToExt);

      // Extension ↔ Content Script (VLAN 'extension')
      const [tExtToContent, tContentToExt] = createLinkedPair(
        'runtime-content', 'runtime',
        ['content:*'],
        ['extension', 'server:*', 'mcp:*'],
      );
      await tExtToContent.connect();
      await tContentToExt.connect();
      extension.addTransport(tExtToContent, { vlan: 'extension' });
      contentScript.addTransport(tContentToExt);
    });

    it('should deliver ping from MCP to Extension', async () => {
      const received: HubEnvelope[] = [];
      extension.on('ping', (_, env) => received.push(env));

      mcp.emit('ping', { test: true }, { target: '*' });
      await ticks(3);

      expect(received).toHaveLength(1);
      expect(received[0].source).toBe('mcp:default');
    });

    it('should deliver pong from Extension to MCP', async () => {
      const received: HubEnvelope[] = [];
      mcp.on('pong', (_, env) => received.push(env));

      extension.emit('pong', { pong: true }, { target: 'mcp:default' });
      await ticks(3);

      expect(received).toHaveLength(1);
      expect(received[0].source).toBe('extension');
    });

    it('should forward scope=local only to extension VLAN', async () => {
      const receivedByPanel: HubEnvelope[] = [];
      const receivedByContent: HubEnvelope[] = [];
      const receivedByMcp: HubEnvelope[] = [];
      const receivedByServer: HubEnvelope[] = [];

      debugPanel.on('panel:state', (_, env) => receivedByPanel.push(env));
      contentScript.on('panel:state', (_, env) => receivedByContent.push(env));
      mcp.on('panel:state', (_, env) => receivedByMcp.push(env));
      server.on('panel:state', (_, env) => receivedByServer.push(env));

      // Extension emits with scope='local' (defaultVlan='extension')
      extension.emit('panel:state', { status: 'ok' }, { scope: 'local' });
      await ticks(3);

      // Panel and content script receive (same VLAN 'extension')
      expect(receivedByPanel).toHaveLength(1);
      expect(receivedByContent).toHaveLength(1);

      // MCP and Server should NOT receive (external, different VLAN)
      expect(receivedByMcp).toHaveLength(0);
      expect(receivedByServer).toHaveLength(0);
    });

    it('should forward scope=local to monitor even if different VLAN', async () => {
      const receivedByRelay: HubEnvelope[] = [];
      relay.on('panel:state', (_, env) => receivedByRelay.push(env));

      // Extension emits with scope='local'
      // Relay transport is marked as monitor, so it should receive
      extension.emit('panel:state', { status: 'ok' }, { scope: 'local' });
      await ticks(3);

      // Relay receives because it's a monitor (parasite)
      expect(receivedByRelay).toHaveLength(1);
    });

    it('should track hops through full path', async () => {
      const received: HubEnvelope[] = [];
      extension.on('ping', (_, env) => received.push(env));

      mcp.emit('ping', {}, { target: 'extension' });
      await ticks(3);

      expect(received).toHaveLength(1);
      const hops = received[0].hops!;

      expect(hops.length).toBeGreaterThanOrEqual(2);
      expect(hops[0].node).toBe('mcp:default'); // Origin
      // Last hop should be extension
      expect(hops[hops.length - 1].node).toBe('extension');
    });

    it('should complete request/reply pattern', async () => {
      extension.on('status:request', (_, envelope) => {
        extension.emit('status:response', { status: 'ok' }, {
          target: envelope.source,
          replyToId: envelope.id,
        });
      });

      const response = await mcp.request('status:request', {}, {
        target: 'extension',
        timeoutMs: 1000,
      });

      expect(response.type).toBe('status:response');
      expect(response.payload.status).toBe('ok');
    });

    it('should not create message loops', async () => {
      const receivedByExt: HubEnvelope[] = [];
      const receivedByRelay: HubEnvelope[] = [];

      extension.on('broadcast', (_, env) => receivedByExt.push(env));
      relay.on('broadcast', (_, env) => receivedByRelay.push(env));

      mcp.emit('broadcast', {}, { target: '*' });
      await ticks(10);

      expect(receivedByRelay).toHaveLength(1);
      expect(receivedByExt).toHaveLength(1);
    });
  });

  describe('Message Filtering', () => {
    it('should apply messageFilter on transport', async () => {
      const hub = new HubNode({ nodeId: 'hub' });
      const nodeA = new HubNode({ nodeId: 'node-a' });

      const [tA, tAPeer] = createLinkedPair('to-a', 'to-hub', ['node-a'], ['hub']);
      await tA.connect();
      await tAPeer.connect();

      // Add transport with filter that only allows 'allowed' type
      hub.addTransport(tA, {
        messageFilter: (env) => env.type === 'allowed',
      });
      nodeA.addTransport(tAPeer);

      const receivedByA: HubEnvelope[] = [];
      nodeA.on('allowed', (_, env) => receivedByA.push(env));
      nodeA.on('blocked', (_, env) => receivedByA.push(env));

      hub.emit('allowed', { data: 1 });
      hub.emit('blocked', { data: 2 });
      await tick();

      expect(receivedByA).toHaveLength(1);
      expect(receivedByA[0].type).toBe('allowed');
    });

    it('should allow dynamic filter update via setTransportFilter', async () => {
      const hub = new HubNode({ nodeId: 'hub' });
      const nodeA = new HubNode({ nodeId: 'node-a' });

      const [tA, tAPeer] = createLinkedPair('to-a', 'to-hub', ['node-a'], ['hub']);
      await tA.connect();
      await tAPeer.connect();

      hub.addTransport(tA);
      nodeA.addTransport(tAPeer);

      const receivedByA: HubEnvelope[] = [];
      nodeA.on('test', (_, env) => receivedByA.push(env));

      // Initially no filter - message passes
      hub.emit('test', { n: 1 });
      await tick();
      expect(receivedByA).toHaveLength(1);

      // Set filter to block all
      hub.setTransportFilter('to-a', () => false);

      hub.emit('test', { n: 2 });
      await tick();
      expect(receivedByA).toHaveLength(1); // Still 1, blocked

      // Update filter to allow
      hub.setTransportFilter('to-a', () => true);

      hub.emit('test', { n: 3 });
      await tick();
      expect(receivedByA).toHaveLength(2);
    });

    it('should remove filter when set to null', async () => {
      const hub = new HubNode({ nodeId: 'hub' });
      const nodeA = new HubNode({ nodeId: 'node-a' });

      const [tA, tAPeer] = createLinkedPair('to-a', 'to-hub', ['node-a'], ['hub']);
      await tA.connect();
      await tAPeer.connect();

      // Start with a blocking filter
      hub.addTransport(tA, { messageFilter: () => false });
      nodeA.addTransport(tAPeer);

      const receivedByA: HubEnvelope[] = [];
      nodeA.on('test', (_, env) => receivedByA.push(env));

      hub.emit('test', { n: 1 });
      await tick();
      expect(receivedByA).toHaveLength(0);

      // Remove filter
      hub.setTransportFilter('to-a', null);

      hub.emit('test', { n: 2 });
      await tick();
      expect(receivedByA).toHaveLength(1);
    });

    it('should throw when setting filter on unknown transport', () => {
      const hub = new HubNode({ nodeId: 'hub' });

      expect(() => {
        hub.setTransportFilter('unknown', () => true);
      }).toThrow("Transport 'unknown' not found");
    });

    it('should apply filter to monitor transports', async () => {
      const hub = new HubNode({ nodeId: 'hub' });
      const nodeA = new HubNode({ nodeId: 'node-a' });

      const [tA, tAPeer] = createLinkedPair('monitor', 'to-hub', [], []);
      await tA.connect();
      await tAPeer.connect();

      // Monitor with filter that only allows '@log' type
      hub.addTransport(tA, {
        monitor: true,
        messageFilter: (env) => env.type === '@log',
      });
      nodeA.addTransport(tAPeer);

      const receivedByA: HubEnvelope[] = [];
      nodeA.on('@log', (_, env) => receivedByA.push(env));
      nodeA.on('ping', (_, env) => receivedByA.push(env));

      hub.emit('@log', { msg: 'test' });
      hub.emit('ping', {});
      await tick();

      expect(receivedByA).toHaveLength(1);
      expect(receivedByA[0].type).toBe('@log');
    });

    it('should filter based on payload content', async () => {
      const hub = new HubNode({ nodeId: 'hub' });
      const nodeA = new HubNode({ nodeId: 'node-a' });

      const [tA, tAPeer] = createLinkedPair('to-a', 'to-hub', ['node-a'], ['hub']);
      await tA.connect();
      await tAPeer.connect();

      // Filter that only allows logs with level 'error' or 'warn'
      hub.addTransport(tA, {
        messageFilter: (env) => {
          if (env.type !== 'log') return true;
          const level = env.payload?.level;
          return level === 'error' || level === 'warn';
        },
      });
      nodeA.addTransport(tAPeer);

      const receivedByA: HubEnvelope[] = [];
      nodeA.on('log', (_, env) => receivedByA.push(env));
      nodeA.on('ping', (_, env) => receivedByA.push(env));

      hub.emit('log', { level: 'error', msg: 'critical' });
      hub.emit('log', { level: 'info', msg: 'info' });
      hub.emit('log', { level: 'debug', msg: 'debug' });
      hub.emit('ping', {}); // Non-log should pass
      await tick();

      expect(receivedByA).toHaveLength(2);
      expect(receivedByA[0].payload.level).toBe('error');
      expect(receivedByA[1].type).toBe('ping');
    });
  });

  describe('Bus Transport (N-node)', () => {
    it('should route messages between 3 legs', async () => {
      const hub = new HubNode({ nodeId: 'bot' });
      const adminNode = new HubNode({ nodeId: 'admin' });
      const cliNode = new HubNode({ nodeId: 'cli' });
      const extNode = new HubNode({ nodeId: 'extension' });

      const bus = new BusTransport('ws-bus');
      const adminSide = bus.addLeg('admin');
      const cliSide = bus.addLeg('cli');
      const extSide = bus.addLeg('extension');

      await bus.connect();

      hub.addTransport(bus, { broadcast: true });
      adminNode.addTransport(adminSide);
      cliNode.addTransport(cliSide);
      extNode.addTransport(extSide);

      const receivedByExt: HubEnvelope[] = [];
      extNode.on('hello', (_, env) => receivedByExt.push(env));

      adminNode.emit('hello', { msg: 'from admin' }, { target: 'extension' });
      await ticks(3);

      expect(receivedByExt).toHaveLength(1);
      expect(receivedByExt[0].source).toBe('admin');
      expect(receivedByExt[0].payload.msg).toBe('from admin');
    });

    it('should not echo message back to source (no-echo)', async () => {
      const hub = new HubNode({ nodeId: 'bot' });
      const adminNode = new HubNode({ nodeId: 'admin' });
      const cliNode = new HubNode({ nodeId: 'cli' });

      const bus = new BusTransport('ws-bus');
      const adminSide = bus.addLeg('admin');
      const cliSide = bus.addLeg('cli');

      await bus.connect();

      hub.addTransport(bus, { broadcast: true });
      adminNode.addTransport(adminSide);
      cliNode.addTransport(cliSide);

      const receivedByAdmin: HubEnvelope[] = [];
      const receivedByCli: HubEnvelope[] = [];

      adminNode.on('test', (_, env) => receivedByAdmin.push(env));
      cliNode.on('test', (_, env) => receivedByCli.push(env));

      // Admin emits broadcast — admin should NOT receive it back via bus
      adminNode.emit('test', { data: 1 });
      await ticks(3);

      // Admin receives only its own local delivery (1)
      expect(receivedByAdmin).toHaveLength(1);
      expect(receivedByAdmin[0].source).toBe('admin');

      // CLI receives via bus
      expect(receivedByCli).toHaveLength(1);
      expect(receivedByCli[0].source).toBe('admin');
    });

    it('should allow broadcast flag to forward via same transport', async () => {
      const hub = new HubNode({ nodeId: 'bot' });
      const adminNode = new HubNode({ nodeId: 'admin' });
      const extNode = new HubNode({ nodeId: 'extension' });

      const bus = new BusTransport('ws-bus');
      const adminSide = bus.addLeg('admin');
      const extSide = bus.addLeg('extension');

      await bus.connect();

      // broadcast=true: hub forwards back to ws-bus for other legs
      hub.addTransport(bus, { broadcast: true });
      adminNode.addTransport(adminSide);
      extNode.addTransport(extSide);

      const receivedByExt: HubEnvelope[] = [];
      extNode.on('ping', (_, env) => receivedByExt.push(env));

      // Message arrives from admin via ws-bus → hub routes → forwards back to ws-bus
      adminNode.emit('ping', { from: 'admin' });
      await ticks(3);

      expect(receivedByExt).toHaveLength(1);
      expect(receivedByExt[0].source).toBe('admin');
    });

    it('should preserve P2P no-return rule for non-broadcast transports', async () => {
      const nodeA = new HubNode({ nodeId: 'node-a' });
      const nodeB = new HubNode({ nodeId: 'node-b' });

      const [tA, tB] = createLinkedPair('link', 'link', ['node-b'], ['node-a']);
      await tA.connect();
      await tB.connect();

      // No broadcast flag → classic P2P no-return
      nodeA.addTransport(tA);
      nodeB.addTransport(tB);

      const sentByA: HubEnvelope[] = [];
      const originalSend = tA.send.bind(tA);
      tA.send = (env) => {
        sentByA.push(env);
        originalSend(env);
      };

      nodeA.emit('test', {});
      await tick();

      // Only one send from A (the original), no loop back
      expect(sentByA).toHaveLength(1);
    });

    it('should support request/reply through bus', async () => {
      const hub = new HubNode({ nodeId: 'bot' });
      const adminNode = new HubNode({ nodeId: 'admin' });
      const extNode = new HubNode({ nodeId: 'extension' });

      const bus = new BusTransport('ws-bus');
      const adminSide = bus.addLeg('admin');
      const extSide = bus.addLeg('extension');

      await bus.connect();

      hub.addTransport(bus, { broadcast: true });
      adminNode.addTransport(adminSide);
      extNode.addTransport(extSide);

      // Extension handles status requests
      extNode.on('status:req', (_, envelope) => {
        extNode.emit('status:res', { ok: true }, {
          target: envelope.source,
          replyToId: envelope.id,
        });
      });

      const response = await adminNode.request('status:req', {}, {
        target: 'extension',
        timeoutMs: 1000,
      });

      expect(response.type).toBe('status:res');
      expect(response.payload.ok).toBe(true);
    });

    it('should track hops correctly through bus', async () => {
      const hub = new HubNode({ nodeId: 'bot' });
      const adminNode = new HubNode({ nodeId: 'admin' });
      const extNode = new HubNode({ nodeId: 'extension' });

      const bus = new BusTransport('ws-bus');
      const adminSide = bus.addLeg('admin');
      const extSide = bus.addLeg('extension');

      await bus.connect();

      hub.addTransport(bus, { broadcast: true });
      adminNode.addTransport(adminSide);
      extNode.addTransport(extSide);

      const received: HubEnvelope[] = [];
      extNode.on('trace', (_, env) => received.push(env));

      adminNode.emit('trace', {}, { target: 'extension' });
      await ticks(3);

      expect(received).toHaveLength(1);
      const hops = received[0].hops!;

      // admin → bot (via ws-bus) → extension (via ws-bus)
      expect(hops[0].node).toBe('admin');
      expect(hops[1].node).toBe('bot');
      expect(hops[1].transport).toBe('ws-bus');
      expect(hops[2].node).toBe('extension');
      expect(hops[2].transport).toBe('ws-bus');
    });
  });

  describe('Dynamic Node Identity', () => {
    it('should allow updating nodeId after construction', () => {
      const node = new HubNode({ nodeId: 'temp' });
      expect(node.nodeId).toBe('temp');

      node.nodeId = 'admin:user1:1234';
      expect(node.nodeId).toBe('admin:user1:1234');
    });

    it('should use updated nodeId as source on emitted envelopes', () => {
      const node = new HubNode({ nodeId: 'temp' });
      node.nodeId = 'admin:user1:1234';

      const received: HubEnvelope[] = [];
      node.on('test', (_, env) => received.push(env));
      node.emit('test', {});

      expect(received[0].source).toBe('admin:user1:1234');
    });

    it('should route replies to dynamic clientId via bus', async () => {
      const hub = new HubNode({ nodeId: 'bot' });
      const extNode = new HubNode({ nodeId: 'extension' });

      // Admin starts with temp id, then gets server-assigned clientId
      const adminNode = new HubNode({ nodeId: 'admin' });
      adminNode.nodeId = 'admin:user1:1707000000';

      const bus = new BusTransport('ws-bus');
      // Leg name matches the dynamic clientId
      const adminSide = bus.addLeg('admin:user1:1707000000');
      const extSide = bus.addLeg('extension');

      await bus.connect();

      hub.addTransport(bus, { broadcast: true });
      adminNode.addTransport(adminSide);
      extNode.addTransport(extSide);

      // Extension handles requests and replies to source
      extNode.on('status:req', (_, envelope) => {
        extNode.emit('status:res', { ok: true }, {
          target: envelope.source,
          replyToId: envelope.id,
        });
      });

      const response = await adminNode.request('status:req', {}, {
        target: 'extension',
        timeoutMs: 1000,
      });

      expect(response.type).toBe('status:res');
      expect(response.payload.ok).toBe(true);
    });

    it('should isolate multiple admin clients on same bus', async () => {
      const hub = new HubNode({ nodeId: 'bot' });
      const extNode = new HubNode({ nodeId: 'extension' });
      const admin1 = new HubNode({ nodeId: 'admin:user1:100' });
      const admin2 = new HubNode({ nodeId: 'admin:user2:200' });

      const bus = new BusTransport('ws-bus');
      const admin1Side = bus.addLeg('admin:user1:100');
      const admin2Side = bus.addLeg('admin:user2:200');
      const extSide = bus.addLeg('extension');

      await bus.connect();

      hub.addTransport(bus, { broadcast: true });
      admin1.addTransport(admin1Side);
      admin2.addTransport(admin2Side);
      extNode.addTransport(extSide);

      // Extension replies to source
      extNode.on('ping', (_, envelope) => {
        extNode.emit('pong', { for: envelope.source }, {
          target: envelope.source,
          replyToId: envelope.id,
        });
      });

      const receivedByAdmin1: HubEnvelope[] = [];
      const receivedByAdmin2: HubEnvelope[] = [];

      admin1.on('pong', (_, env) => receivedByAdmin1.push(env));
      admin2.on('pong', (_, env) => receivedByAdmin2.push(env));

      // Admin1 sends ping
      admin1.emit('ping', {}, { target: 'extension' });
      await ticks(3);

      // Only admin1 gets the reply (targeted)
      expect(receivedByAdmin1).toHaveLength(1);
      expect(receivedByAdmin1[0].payload.for).toBe('admin:user1:100');
      expect(receivedByAdmin2).toHaveLength(0);
    });

    it('should broadcast @log to all admin clients but not echo to source', async () => {
      const hub = new HubNode({ nodeId: 'bot' });
      const extNode = new HubNode({ nodeId: 'extension' });
      const admin1 = new HubNode({ nodeId: 'admin:user1:100' });
      const admin2 = new HubNode({ nodeId: 'admin:user2:200' });

      const bus = new BusTransport('ws-bus');
      const admin1Side = bus.addLeg('admin:user1:100');
      const admin2Side = bus.addLeg('admin:user2:200');
      const extSide = bus.addLeg('extension');

      await bus.connect();

      hub.addTransport(bus, { broadcast: true });
      admin1.addTransport(admin1Side);
      admin2.addTransport(admin2Side);
      extNode.addTransport(extSide);

      const receivedByAdmin1: HubEnvelope[] = [];
      const receivedByAdmin2: HubEnvelope[] = [];
      const receivedByExt: HubEnvelope[] = [];

      admin1.on('@log', (_, env) => receivedByAdmin1.push(env));
      admin2.on('@log', (_, env) => receivedByAdmin2.push(env));
      extNode.on('@log', (_, env) => receivedByExt.push(env));

      // Extension broadcasts @log
      extNode.emit('@log', { msg: 'hello' });
      await ticks(3);

      // Both admins receive (broadcast target='*')
      expect(receivedByAdmin1).toHaveLength(1);
      expect(receivedByAdmin2).toHaveLength(1);
      // Extension gets only local delivery (1), no echo back from bus
      expect(receivedByExt).toHaveLength(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle disconnected transport gracefully', async () => {
      const nodeA = new HubNode({ nodeId: 'node-a' });
      const nodeB = new HubNode({ nodeId: 'node-b' });

      const [tA, tB] = createLinkedPair('to-b', 'to-a', ['node-b'], ['node-a']);

      await tA.connect();
      // tB not connected

      nodeA.addTransport(tA);
      nodeB.addTransport(tB);

      const received: HubEnvelope[] = [];
      nodeB.on('test', (_, env) => received.push(env));

      nodeA.emit('test', {});
      await tick();

      expect(received).toHaveLength(0);
    });

    it('should handle multiple handlers for same type', () => {
      const node = new HubNode({ nodeId: 'test' });
      const results: number[] = [];

      node.on('multi', () => results.push(1));
      node.on('multi', () => results.push(2));
      node.on('multi', () => results.push(3));

      node.emit('multi', {});

      expect(results).toEqual([1, 2, 3]);
    });

    it('should allow unsubscribe', () => {
      const node = new HubNode({ nodeId: 'test' });
      const results: number[] = [];

      const unsub = node.on('test', () => results.push(1));

      node.emit('test', {});
      expect(results).toEqual([1]);

      unsub();

      node.emit('test', {});
      expect(results).toEqual([1]);
    });

    it('should handle handler errors gracefully', () => {
      const node = new HubNode({ nodeId: 'test' });
      const results: number[] = [];

      node.on('test', () => {
        throw new Error('Handler error');
      });
      node.on('test', () => results.push(2));

      node.emit('test', {});

      expect(results).toEqual([2]);
    });
  });

  describe('Proxy node (target === nodeId with relay transport)', () => {
    /**
     * Scenario : a HubNode acts as a PROXY for the same identity it carries.
     * Concrete case (a server-side bot proxy) :
     *   - server-side hub.nodeId = 'bot:<uuid>'
     *   - BusTransport with peerPatterns=['extension', 'bot:<uuid>'] bridging
     *     to the real bot over WS
     *   - admin/CLI sends envelope target='bot:<uuid>' via backbone
     * The hub must NOT shortcut on `target === this.nodeId` and instead forward
     * to the BusTransport so the bot WS receives the message.
     */
    it('should forward via proxy transport when target matches a non-wildcard peer pattern', async () => {
      const hub = new HubNode({ nodeId: 'bot:42' });
      const bus = new BusTransport('ws-bus');
      // Extension leg : peerPatterns include the same identity as the hub.
      const extension = bus.addLeg('bot:42', ['extension', 'bot:42']);
      const received: HubEnvelope[] = [];
      extension.onReceive((env) => received.push(env));

      hub.addTransport(bus, { broadcast: true });
      await bus.connect();

      // Simulate envelope arriving from external source (target = our nodeId)
      hub.receive(null, {
        id: 'msg-1',
        type: 'ping',
        payload: {},
        source: 'external',
        target: 'bot:42',
        scope: 'global',
        timestamp: Date.now(),
        hops: [{ node: 'external' }],
      });

      await tick();
      expect(received).toHaveLength(1);
      expect(received[0]!.type).toBe('ping');
    });

    it('should still shortcut when no transport claims the target (vanilla case)', () => {
      const hub = new HubNode({ nodeId: 'cli-only' });
      // Only a wildcard transport — no proxy semantics
      const [tBackbone] = createLinkedPair('backbone', 'cli-only', ['*'], ['cli-only']);
      hub.addTransport(tBackbone);

      const sentOut: HubEnvelope[] = [];
      tBackbone.send = (env) => sentOut.push(env);

      const handlerCalls: HubEnvelope[] = [];
      hub.on('ping', (env) => handlerCalls.push(env));

      hub.receive(null, {
        id: 'msg-2',
        type: 'ping',
        payload: {},
        source: 'someone',
        target: 'cli-only',
        scope: 'global',
        timestamp: Date.now(),
        hops: [{ node: 'someone' }],
      });

      // Local handler fires, no outbound forward (would loop back to backbone)
      expect(handlerCalls).toHaveLength(1);
      expect(sentOut).toHaveLength(0);
    });
  });
});
