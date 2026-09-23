/**
 * Hub Node - A node in the distributed hub network
 *
 * Each hub node:
 * - Has local subscribers (handlers)
 * - Has transports (connections to peer nodes)
 * - Routes messages based on scope, VLAN, and target
 * - Deduplicates messages to prevent loops
 * - Tracks routing path (hops) for debugging
 */

import {
  HubEnvelope,
  HubHop,
  HubScope,
  HubNodeConfig,
  Transport,
  TransportState,
  MessageHandler,
  MessageFilter,
  RoutingDecision,
  AddTransportOptions,
  EmitOptions,
} from './types.js';

const DEFAULT_SEEN_TTL_MS = 60_000;

/** System event prefix - events starting with @ are hub infrastructure events */
const SYSTEM_EVENT_PREFIX = '@';

/** Internal transport metadata (hub owns routing config, not transport) */
interface TransportMeta {
  transport: Transport;
  vlans: Set<string>;
  monitor: boolean;
  broadcast: boolean;
  messageFilter?: MessageFilter;
  stateUnsubscribe?: () => void;
}

export class HubNode {
  nodeId: string;
  private readonly defaultScope: HubScope;
  private readonly vlans: Set<string>;
  private readonly defaultVlan?: string;
  private readonly seenTtlMs: number;

  private transports = new Map<string, TransportMeta>();
  private handlers = new Map<string, Set<MessageHandler>>();
  private localMonitors = new Set<(envelope: HubEnvelope) => void>();
  private seen = new Map<string, number>();

  constructor(config: HubNodeConfig) {
    this.nodeId = config.nodeId;
    this.defaultScope = config.defaultScope ?? 'global';
    this.vlans = new Set(config.vlans ?? []);
    this.defaultVlan = config.defaultVlan ?? config.vlans?.[0];
    this.seenTtlMs = config.seenTtlMs ?? DEFAULT_SEEN_TTL_MS;
  }

  // ============================================================
  // Transport Management
  // ============================================================

  /**
   * Add a transport to this hub node
   *
   * @param transport The transport (dumb pipe)
   * @param options VLAN assignment and monitor mode
   */
  addTransport(transport: Transport, options: AddTransportOptions = {}): void {
    if (this.transports.has(transport.name)) {
      throw new Error(`Transport '${transport.name}' already registered`);
    }

    // Normalize vlan option to Set
    const vlans = new Set<string>();
    if (options.vlan) {
      const vlanArray = Array.isArray(options.vlan) ? options.vlan : [options.vlan];
      vlanArray.forEach((v) => vlans.add(v));
    }

    const meta: TransportMeta = {
      transport,
      vlans,
      monitor: options.monitor ?? false,
      broadcast: options.broadcast ?? false,
      messageFilter: options.messageFilter,
    };

    this.transports.set(transport.name, meta);

    // Subscribe to incoming messages
    transport.onReceive((envelope) => {
      this.receive(transport.name, envelope);
    });

    // Subscribe to state changes and emit system events
    let prevState: TransportState = { ...transport.state };
    transport.onStateChange((state) => {
      // Connection state transitions
      if (state.connected && !prevState.connected) {
        this.emitSystem('@transport:connected', { name: transport.name });
      } else if (!state.connected && prevState.connected) {
        this.emitSystem('@transport:disconnected', { name: transport.name });
      }

      // Reconnecting state transition
      if (state.reconnecting && !prevState.reconnecting) {
        this.emitSystem('@transport:reconnecting', { name: transport.name });
      }

      prevState = { ...state };
    });

    // Emit system event for transport added
    this.emitSystem('@transport:added', {
      name: transport.name,
      peerPatterns: transport.peerPatterns,
      monitor: meta.monitor,
    });

    // If transport is already connected, emit @transport:connected immediately
    if (transport.state.connected) {
      this.emitSystem('@transport:connected', { name: transport.name });
    }
  }

  /**
   * Remove a transport
   */
  removeTransport(name: string): void {
    const meta = this.transports.get(name);
    if (meta) {
      meta.transport.disconnect?.();
      this.transports.delete(name);

      // Emit system event for transport removed
      this.emitSystem('@transport:removed', { name });
    }
  }

  /**
   * Set or update the message filter for a transport
   *
   * @param name Transport name
   * @param filter Filter function, or null to remove the filter
   */
  setTransportFilter(name: string, filter: MessageFilter | null): void {
    const meta = this.transports.get(name);
    if (!meta) {
      throw new Error(`Transport '${name}' not found`);
    }
    meta.messageFilter = filter ?? undefined;
  }

  /**
   * Get all registered transports
   */
  getTransports(): Transport[] {
    return Array.from(this.transports.values()).map((m) => m.transport);
  }

  // ============================================================
  // Local Subscriptions
  // ============================================================

  /**
   * Subscribe to a message type
   */
  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    return () => this.off(type, handler);
  }

  /**
   * Unsubscribe from a message type
   */
  off(type: string, handler: MessageHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  /**
   * Add a local monitor (receives all messages for debugging)
   */
  monitor(handler: (envelope: HubEnvelope) => void): () => void {
    this.localMonitors.add(handler);
    return () => this.localMonitors.delete(handler);
  }

  // ============================================================
  // Message Emission
  // ============================================================

  /**
   * Emit a message from this node
   */
  emit(type: string, payload: any = {}, options: EmitOptions = {}): HubEnvelope {
    const scope = options.scope ?? this.defaultScope;

    // For scope='local', use explicit vlan or defaultVlan
    const vlan = scope === 'local' ? (options.vlan ?? this.defaultVlan) : undefined;

    const envelope: HubEnvelope = {
      id: this.generateId(),
      type,
      payload,
      source: this.nodeId,
      target: options.target ?? '*',
      scope,
      timestamp: Date.now(),
      replyToId: options.replyToId,
      vlan,
      hops: [{ node: this.nodeId }], // Start routing trace (origin has no transport)
      meta: options.meta,
    };

    // Process as if received locally (null = no source transport)
    this.receive(null, envelope);

    return envelope;
  }

  /**
   * Request/Reply helper - returns full envelope
   */
  request(
    type: string,
    payload: any = {},
    options: {
      target?: string;
      timeoutMs?: number;
      meta?: Record<string, any>;
    } = {},
  ): Promise<HubEnvelope> {
    const timeoutMs = options.timeoutMs ?? 5000;

    return new Promise((resolve, reject) => {
      const envelope = this.emit(type, payload, {
        target: options.target,
        meta: options.meta,
      });

      let settled = false;

      const unsubscribe = this.monitor((reply) => {
        if (reply.replyToId === envelope.id) {
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve(reply);
        }
      });

      const timer = setTimeout(() => {
        if (!settled) {
          unsubscribe();
          reject(new Error(`Request timeout for ${type} (${timeoutMs}ms)`));
        }
      }, timeoutMs);
    });
  }

  /**
   * Simple query helper - returns just the payload
   */
  async query<T = any>(
    type: string,
    payload: any = {},
    target?: string,
    expectedType?: string,
    timeoutMs: number = 5000,
  ): Promise<T> {
    if (!expectedType) {
      const reply = await this.request(type, payload, { target, timeoutMs });
      return reply.payload as T;
    }

    return new Promise((resolve, reject) => {
      const envelope = this.emit(type, payload, { target });
      let settled = false;

      const unsubscribe = this.monitor((reply) => {
        const matchesReply = reply.replyToId === envelope.id;
        const matchesType =
          reply.type === expectedType && (reply.target === this.nodeId || reply.target === '*');

        if (matchesReply || matchesType) {
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve(reply.payload as T);
        }
      });

      const timer = setTimeout(() => {
        if (!settled) {
          unsubscribe();
          reject(new Error(`Query timeout for ${type} → ${expectedType} (${timeoutMs}ms)`));
        }
      }, timeoutMs);
    });
  }

  // ============================================================
  // Message Reception & Routing
  // ============================================================

  /**
   * Receive a message (from transport or local emit)
   */
  receive(fromTransport: string | null, envelope: HubEnvelope): void {
    // 1. Deduplication
    if (this.hasSeen(envelope.id)) {
      return;
    }
    this.markSeen(envelope.id);

    // 2. Add this node to hops (with transport info)
    const hops = envelope.hops ?? [];
    const lastHop = hops[hops.length - 1];
    if (lastHop?.node !== this.nodeId) {
      const hop: HubHop = { node: this.nodeId };
      if (fromTransport) {
        hop.transport = fromTransport;
      }
      envelope.hops = [...hops, hop];
    }

    // 3. Routing decision
    const decision = this.route(fromTransport, envelope);

    // 4. Local delivery
    if (decision.deliverLocal) {
      this.deliverLocal(envelope);
    }

    // 5. Forward to transports
    decision.forwardTo.forEach((transport) => {
      transport.send(envelope);
    });
  }

  // ============================================================
  // Router Logic
  // ============================================================

  /**
   * Make routing decision for an envelope
   */
  private route(fromTransport: string | null, envelope: HubEnvelope): RoutingDecision {
    const { target, scope, vlan } = envelope;

    // Should we deliver locally?
    const deliverLocal = this.shouldDeliverLocal(target);

    // Get monitor transports (they always receive, but filters apply)
    const monitors = this.getMonitorTransports(fromTransport, envelope);

    // If we're the target, don't forward to regular transports (only monitors).
    //
    // EXCEPTION : un node PROXY peut avoir nodeId === target tout en etant
    // un relais pour un peer reel. Ex : bot-hub-manager cote serveur cree un
    // HubNode avec nodeId=`bot:<uuid>` dont le BusTransport a
    // peerPatterns=['extension', 'bot:<uuid>'] — la BusTransport est le pont
    // vers le vrai bot (en WS). Dans ce cas, le shortcut bloquait le forward
    // et l'envelope etait dropped.
    //
    // Heuristique : si une transport declare le target dans un pattern
    // NON-wildcard (exact ou prefix-`*`, pas `*` tout seul), on la considere
    // comme proxy et on laisse selectForwardTransports router normalement.
    if (target === this.nodeId) {
      const hasProxyTransport = this.hasNonWildcardTransportForTarget(target, fromTransport);
      if (!hasProxyTransport) {
        return { deliverLocal, forwardTo: monitors };
      }
    }

    // Select transports to forward to
    let forwardTo: Transport[] = [];

    if (scope === 'local') {
      // scope='local' → only forward to transports in the same VLAN
      forwardTo = this.selectForwardTransports(fromTransport, target, envelope, vlan);
    } else {
      // scope='global' → forward to all appropriate transports
      forwardTo = this.selectForwardTransports(fromTransport, target, envelope);
    }

    // Always add monitor transports (parasites get everything)
    monitors.forEach((t) => {
      if (!forwardTo.includes(t)) {
        forwardTo.push(t);
      }
    });

    return { deliverLocal, forwardTo };
  }

  /**
   * Check if message should be delivered to local subscribers
   */
  private shouldDeliverLocal(target: string): boolean {
    if (target === '*') return true;
    if (target === this.nodeId) return true;
    // For now, always deliver locally and let handlers filter
    return true;
  }

  /**
   * Select which transports to forward the message to
   */
  private selectForwardTransports(
    fromTransport: string | null,
    target: string,
    envelope: HubEnvelope,
    vlanFilter?: string,
  ): Transport[] {
    const candidates: Transport[] = [];

    for (const [name, meta] of this.transports) {
      // No-return rule: don't send back to source (unless broadcast transport)
      if (name === fromTransport && !meta.broadcast) continue;

      // Skip disconnected transports
      if (!meta.transport.state.connected) continue;

      // Skip monitor transports (handled separately)
      if (meta.monitor) continue;

      // VLAN filter for scope='local'
      if (vlanFilter !== undefined) {
        // Transport must be on this VLAN (no VLAN = no membership = excluded)
        if (!meta.vlans.has(vlanFilter)) {
          continue;
        }
      }

      // Apply message filter (for parametric routing like log subscriptions)
      if (meta.messageFilter && !meta.messageFilter(envelope)) {
        continue;
      }

      candidates.push(meta.transport);
    }

    if (target === '*') {
      // Broadcast: forward to all eligible
      return candidates;
    }

    // Smart routing: prefer specific pattern match over wildcard catch-all ('*')
    const specificMatch = candidates.find((t) =>
      t.peerPatterns.some((p) => {
        if (p === '*') return false;
        if (p.endsWith('*')) return target.startsWith(p.slice(0, -1));
        return p === target;
      }),
    );
    if (specificMatch) {
      return [specificMatch];
    }

    // Fall back to any transport that can reach the target (including '*')
    const matchingTransport = candidates.find((t) => this.transportKnowsTarget(t, target));
    if (matchingTransport) {
      return [matchingTransport];
    }

    // Unknown target: broadcast to all eligible
    return candidates;
  }

  /**
   * Get monitor transports (parasites that receive everything, but filters apply)
   */
  private getMonitorTransports(fromTransport: string | null, envelope: HubEnvelope): Transport[] {
    const monitors: Transport[] = [];

    for (const [name, meta] of this.transports) {
      if (name === fromTransport && !meta.broadcast) continue;
      if (!meta.transport.state.connected) continue;
      if (!meta.monitor) continue;

      // Apply message filter even for monitors (enables selective monitoring)
      if (meta.messageFilter && !meta.messageFilter(envelope)) {
        continue;
      }

      monitors.push(meta.transport);
    }

    return monitors;
  }

  /**
   * Check if any connected, non-monitor transport (other than fromTransport)
   * declares the target via a NON-wildcard peerPattern — i.e. acts as a
   * proxy/gateway for that specific target. Used to decide whether
   * `target === nodeId` means "I'm the destination" or "I'm a relay".
   */
  private hasNonWildcardTransportForTarget(target: string, fromTransport: string | null): boolean {
    for (const [name, meta] of this.transports) {
      if (name === fromTransport) continue;
      if (meta.monitor) continue;
      if (!meta.transport.state.connected) continue;
      const hit = meta.transport.peerPatterns.some((p) => {
        if (p === '*') return false;
        if (p.endsWith('*')) return target.startsWith(p.slice(0, -1));
        return p === target;
      });
      if (hit) return true;
    }
    return false;
  }

  /**
   * Check if a transport knows how to reach a target
   */
  private transportKnowsTarget(transport: Transport, target: string): boolean {
    return transport.peerPatterns.some((pattern) => {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        return target.startsWith(prefix);
      }
      return pattern === target;
    });
  }

  /**
   * Deliver message to local subscribers
   */
  private deliverLocal(envelope: HubEnvelope): void {
    // Notify local monitors
    this.localMonitors.forEach((m) => {
      try {
        m(envelope);
      } catch (e) {
        console.error(`[HubNode:${this.nodeId}] Monitor error:`, e);
      }
    });

    // Notify type handlers
    const typeHandlers = this.handlers.get(envelope.type);
    if (typeHandlers) {
      typeHandlers.forEach((h) => {
        try {
          h(envelope.payload, envelope);
        } catch (e) {
          console.error(`[HubNode:${this.nodeId}] Handler error for ${envelope.type}:`, e);
        }
      });
    }
  }

  // ============================================================
  // Deduplication
  // ============================================================

  private hasSeen(id: string): boolean {
    const ts = this.seen.get(id);
    if (!ts) return false;
    if (Date.now() - ts > this.seenTtlMs) {
      this.seen.delete(id);
      return false;
    }
    return true;
  }

  private markSeen(id: string): void {
    this.seen.set(id, Date.now());
    this.pruneOldSeen();
  }

  private pruneOldSeen(): void {
    const now = Date.now();
    for (const [id, ts] of this.seen.entries()) {
      if (now - ts > this.seenTtlMs) {
        this.seen.delete(id);
      }
    }
  }

  // ============================================================
  // Utilities
  // ============================================================

  private generateId(): string {
    return `${this.nodeId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // ============================================================
  // System Events (@)
  // ============================================================

  /**
   * Check if a message type is a system event
   */
  static isSystemEvent(type: string): boolean {
    return type.startsWith(SYSTEM_EVENT_PREFIX);
  }

  /**
   * Emit a system event (@ prefix)
   *
   * System events are hub infrastructure messages:
   * - @transport:added, @transport:removed
   * - @transport:connected, @transport:disconnected
   * - @node:joined, @node:leaving
   *
   * By default, system events have scope='local' (don't cross network boundaries)
   */
  private emitSystem(type: string, payload: any = {}): HubEnvelope {
    return this.emit(type, payload, { scope: 'local' });
  }
}
