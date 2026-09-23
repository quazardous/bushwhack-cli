/**
 * Memory Transport - For testing hub networks
 *
 * Simulates a transport connection between two hub nodes in memory.
 * Use createLinkedPair() to create two connected transports.
 */

import { Transport, TransportState, HubEnvelope } from './types.js';

export class MemoryTransport implements Transport {
  readonly name: string;
  private _state: TransportState = { connected: false };
  private _peerPatterns: string[] = [];
  private _receiveHandler: ((envelope: HubEnvelope) => void) | null = null;
  private _stateHandler: ((state: TransportState) => void) | null = null;
  private _peer: MemoryTransport | null = null;

  constructor(name: string, peerPatterns: string[] = []) {
    this.name = name;
    this._peerPatterns = peerPatterns;
  }

  get state(): TransportState {
    return this._state;
  }

  get peerPatterns(): string[] {
    return this._peerPatterns;
  }

  setPeerPatterns(patterns: string[]): void {
    this._peerPatterns = patterns;
  }

  send(envelope: HubEnvelope): void {
    if (!this._state.connected || !this._peer) {
      return;
    }
    // Check peer is also connected (simulates real connection)
    if (!this._peer._state.connected) {
      return;
    }
    // Simulate async delivery (next tick)
    Promise.resolve().then(() => {
      this._peer?._deliver(envelope);
    });
  }

  onReceive(handler: (envelope: HubEnvelope) => void): void {
    this._receiveHandler = handler;
  }

  onStateChange(handler: (state: TransportState) => void): void {
    this._stateHandler = handler;
  }

  async connect(): Promise<void> {
    this._setState({ connected: true });
  }

  disconnect(): void {
    this._setState({ connected: false });
  }

  /** Link this transport to a peer transport (bidirectional) */
  linkTo(peer: MemoryTransport): void {
    this._peer = peer;
    peer._peer = this;
  }

  /** Internal: deliver message from peer */
  _deliver(envelope: HubEnvelope): void {
    this._receiveHandler?.(envelope);
  }

  private _setState(state: TransportState): void {
    this._state = state;
    this._stateHandler?.(state);
  }
}

/**
 * Create a pair of linked memory transports
 *
 * @param nameA Name for transport A
 * @param nameB Name for transport B
 * @param peerPatternsA Peer patterns reachable via A (what A knows about B's side)
 * @param peerPatternsB Peer patterns reachable via B (what B knows about A's side)
 */
export function createLinkedPair(
  nameA: string,
  nameB: string,
  peerPatternsA: string[] = [],
  peerPatternsB: string[] = [],
): [MemoryTransport, MemoryTransport] {
  const transportA = new MemoryTransport(nameA, peerPatternsA);
  const transportB = new MemoryTransport(nameB, peerPatternsB);
  transportA.linkTo(transportB);
  return [transportA, transportB];
}
