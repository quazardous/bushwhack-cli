/**
 * Hub Network Types
 *
 * A distributed hub network where each node is autonomous and
 * forwards messages based on scope and target routing.
 */

export type HubScope = 'local' | 'global';

/**
 * A hop in the routing trace
 */
export interface HubHop {
  node: string;         // nodeId
  transport?: string;   // transport name used to receive (undefined for origin)
}

export interface HubEnvelope {
  id: string;
  type: string;
  payload: any;
  source: string;      // nodeId who created the message
  target: string;      // '*' for broadcast, or specific nodeId/pattern
  scope: HubScope;
  timestamp: number;
  replyToId?: string;
  vlan?: string;       // explicit VLAN for scope='local' routing
  hops?: HubHop[];     // routing trace: nodes and transports the message passed through
  meta?: Record<string, any>;
}

export type MessageHandler = (payload: any, envelope: HubEnvelope) => void;

export interface TransportState {
  connected: boolean;
  reconnecting?: boolean;
  error?: string;
}

/**
 * Transport interface - a dumb pipe to peer(s)
 *
 * Transport is just a communication channel. It doesn't know about
 * VLANs or routing - that's the hub's responsibility.
 */
export interface Transport {
  /** Unique name for this transport */
  readonly name: string;

  /** Current connection state */
  readonly state: TransportState;

  /** Peer patterns reachable via this transport (e.g., 'mcp:*', 'debug-panel') */
  readonly peerPatterns: string[];

  /** Send an envelope through this transport */
  send(envelope: HubEnvelope): void;

  /** Register handler for incoming messages */
  onReceive(handler: (envelope: HubEnvelope) => void): void;

  /** Register handler for state changes */
  onStateChange(handler: (state: TransportState) => void): void;

  /** Connect (if applicable) */
  connect?(): Promise<void>;

  /** Disconnect (if applicable) */
  disconnect?(): void;
}

/**
 * Message filter function type
 * Return true to allow the message through, false to block it
 */
export type MessageFilter = (envelope: HubEnvelope) => boolean;

/**
 * Options when adding a transport to the hub
 */
export interface AddTransportOptions {
  /**
   * VLAN(s) this transport belongs to.
   * Messages with scope='local' only forward to transports in the same VLAN.
   */
  vlan?: string | string[];

  /**
   * Monitor mode (parasite/span port).
   * Monitor transports receive a copy of ALL messages for observability.
   */
  monitor?: boolean;

  /**
   * Optional message filter for this transport.
   * If provided, only messages where filter returns true are forwarded.
   * This enables parametric routing (e.g., log subscription filtering).
   */
  messageFilter?: MessageFilter;

  /**
   * Bus mode: allow forwarding back to the same transport.
   * When true, the no-return rule is disabled for this transport,
   * letting it act as a broadcast bus for N connected nodes.
   * The transport itself is responsible for skipping envelope.source.
   */
  broadcast?: boolean;
}

/**
 * Hub Node configuration
 */
export interface HubNodeConfig {
  /** Unique identifier for this node */
  nodeId: string;

  /** Default scope for emitted messages */
  defaultScope?: HubScope;

  /**
   * VLANs this node belongs to.
   * Used for routing scope='local' messages.
   */
  vlans?: string[];

  /**
   * Default VLAN for scope='local' messages without explicit vlan.
   * Falls back to first vlan in vlans[] if not specified.
   */
  defaultVlan?: string;

  /** TTL for seen message deduplication (ms) */
  seenTtlMs?: number;
}

/**
 * Emit options for hub.emit()
 */
export interface EmitOptions {
  target?: string;
  scope?: HubScope;
  vlan?: string;       // explicit VLAN for scope='local'
  replyToId?: string;
  meta?: Record<string, any>;
}

/**
 * Routing decision result
 */
export interface RoutingDecision {
  /** Deliver to local subscribers */
  deliverLocal: boolean;

  /** Transports to forward to */
  forwardTo: Transport[];
}
