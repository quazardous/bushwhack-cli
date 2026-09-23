/**
 * A hub node on a session's relay: what the extension's service worker is, and what the
 * CLI clients are. Both ask the daemon the same two things.
 */
import { HubNode, WebSocketTransport } from '@bushwhack/hub';
import { BRIDGE, type BridgeError, type ToolsCallReply, type ToolsCallRequest, type ToolsListReply, type ToolsListRequest } from '@bushwhack/protocol';

export interface BridgeClient {
  list(request?: ToolsListRequest): Promise<ToolsListReply>;
  call(request: ToolsCallRequest, timeoutMs: number): Promise<ToolsCallReply>;
  close(): void;
}

function unwrap<T>(payload: T | BridgeError): T {
  if (payload && typeof payload === 'object' && 'error' in payload) throw new Error(payload.error);
  return payload as T;
}

export async function connectBridge(options: {
  port: number;
  code: string;
  daemonNodeId: string;
  nodeId: string;
  client: string;
}): Promise<BridgeClient> {
  const node = new HubNode({ nodeId: options.nodeId, defaultScope: 'global' });
  const transport = new WebSocketTransport({
    name: 'relay',
    url: `ws://127.0.0.1:${options.port}`,
    peerPatterns: ['*'],
    reconnect: { maxAttempts: 1 },
    registrationMessage: { type: 'register', nodeId: options.nodeId, securityKey: options.code, client: options.client },
  });
  node.addTransport(transport);
  await transport.connect();

  return {
    async list(request = {}) {
      const reply = await node.request(BRIDGE.list, request, { target: options.daemonNodeId, timeoutMs: 5000 });
      return unwrap<ToolsListReply>(reply.payload);
    },
    async call(request, timeoutMs) {
      const reply = await node.request(BRIDGE.call, request, { target: options.daemonNodeId, timeoutMs });
      return unwrap<ToolsCallReply>(reply.payload);
    },
    close() {
      transport.disconnect();
    },
  };
}
