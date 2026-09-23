/**
 * BusTransport - N-node broadcast transport using MemoryTransport pairs.
 *
 * Each connected node ("leg") is a MemoryTransport pair:
 * - busSide: owned by the bus, receives messages from the node
 * - nodeSide: given to the HubNode, used to send/receive messages
 *
 * When the hub forwards a message through the bus, send() delivers
 * to all legs except the envelope.source (no-echo). This allows
 * the hub's no-return rule to be bypassed (broadcast=true) while
 * the bus itself handles source exclusion.
 *
 * Architecture:
 * ```
 * BusTransport "ws-bus" (on bot's HubNode)
 * ├── leg "admin"     → busSide ↔ nodeSide → admin HubNode
 * ├── leg "cli"       → busSide ↔ nodeSide → cli HubNode
 * └── leg "extension" → busSide ↔ nodeSide → extension HubNode
 * ```
 */

import { Transport, TransportState, HubEnvelope } from './types.js';
import { MemoryTransport } from './memory-transport.js';

interface BusLeg {
  nodeId: string;
  busSide: MemoryTransport;
  nodeSide: MemoryTransport;
  peerPatterns?: string[];
}

export class BusTransport implements Transport {
  readonly name: string;
  private _state: TransportState = { connected: false };
  private legs = new Map<string, BusLeg>();
  private receiveHandler: ((envelope: HubEnvelope) => void) | null = null;
  private stateHandler: ((state: TransportState) => void) | null = null;

  constructor(name: string) {
    this.name = name;
  }

  get state(): TransportState {
    return this._state;
  }

  /** Peer patterns built dynamically from all leg nodeIds */
  get peerPatterns(): string[] {
    return Array.from(this.legs.values()).flatMap((leg) =>
      leg.peerPatterns ?? [leg.nodeId],
    );
  }

  /**
   * Add a leg to the bus for a node.
   *
   * @param nodeId - Identifier for the connected node
   * @param peerPatterns - Patterns reachable via this leg (defaults to [nodeId])
   * @returns The nodeSide MemoryTransport to give to the node's HubNode
   */
  addLeg(nodeId: string, peerPatterns?: string[]): MemoryTransport {
    if (this.legs.has(nodeId)) {
      throw new Error(`Leg '${nodeId}' already exists on bus '${this.name}'`);
    }

    const busSide = new MemoryTransport(`${this.name}:bus:${nodeId}`, [nodeId]);
    const nodeSide = new MemoryTransport(this.name, peerPatterns ?? [nodeId]);

    busSide.linkTo(nodeSide);

    // When the node sends a message, it arrives at busSide → bus receives it
    busSide.onReceive((envelope: HubEnvelope) => {
      this.receiveHandler?.(envelope);
    });

    const leg: BusLeg = { nodeId, busSide, nodeSide, peerPatterns };
    this.legs.set(nodeId, leg);

    // If bus is already connected, connect the new leg
    if (this._state.connected) {
      void busSide.connect();
      void nodeSide.connect();
    }

    return nodeSide;
  }

  /**
   * Send an envelope to matching legs, skipping envelope.source (no-echo).
   *
   * The hub calls this when forwarding through the bus. Since the bus
   * has broadcast=true, the hub's no-return rule is bypassed and the
   * bus handles source exclusion internally.
   */
  send(envelope: HubEnvelope): void {
    if (!this._state.connected) return;

    for (const [, leg] of this.legs) {
      // No-echo: don't send back to the originating node
      if (leg.nodeId === envelope.source) continue;

      // For targeted messages, only send to matching leg
      if (envelope.target !== '*') {
        if (!this.legMatchesTarget(leg, envelope.target)) continue;
      }

      // Send via busSide → arrives at nodeSide._deliver()
      leg.busSide.send(envelope);
    }
  }

  onReceive(handler: (envelope: HubEnvelope) => void): void {
    this.receiveHandler = handler;
  }

  onStateChange(handler: (state: TransportState) => void): void {
    this.stateHandler = handler;
  }

  async connect(): Promise<void> {
    for (const [, leg] of this.legs) {
      await leg.busSide.connect();
      await leg.nodeSide.connect();
    }
    this._state = { connected: true };
    this.stateHandler?.(this._state);
  }

  disconnect(): void {
    for (const [, leg] of this.legs) {
      leg.busSide.disconnect();
      leg.nodeSide.disconnect();
    }
    this._state = { connected: false };
    this.stateHandler?.(this._state);
  }

  removeLeg(nodeId: string): void {
    const leg = this.legs.get(nodeId);
    if (!leg) return;
    leg.busSide.disconnect();
    leg.nodeSide.disconnect();
    this.legs.delete(nodeId);
  }

  hasLeg(nodeId: string): boolean {
    return this.legs.has(nodeId);
  }

  /** Check if a leg can reach the given target */
  private legMatchesTarget(leg: BusLeg, target: string): boolean {
    const patterns = leg.peerPatterns ?? [leg.nodeId];
    return patterns.some((pattern) => {
      if (pattern.endsWith('*')) {
        return target.startsWith(pattern.slice(0, -1));
      }
      return pattern === target;
    });
  }
}
