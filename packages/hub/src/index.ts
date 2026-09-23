/**
 * Hub Network - Distributed message routing
 *
 * A network of hub nodes that route messages based on scope and target.
 * Each node is autonomous and forwards messages to its peers.
 */

// Types
export type {
  HubScope,
  HubHop,
  HubEnvelope,
  MessageHandler,
  MessageFilter,
  TransportState,
  Transport,
  AddTransportOptions,
  HubNodeConfig,
  EmitOptions,
  RoutingDecision,
} from './types.js';

// HubNode
export { HubNode } from './hub-node.js';

// Transports
export { MemoryTransport, createLinkedPair } from './memory-transport.js';
export { WebSocketTransport } from './websocket-transport.js';
export type { WebSocketTransportConfig, ReconnectConfig } from './websocket-transport.js';
export { BusTransport } from './bus-transport.js';
