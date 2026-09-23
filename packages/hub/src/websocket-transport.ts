/**
 * WebSocket Transport - Connects a HubNode to a remote peer via WebSocket
 *
 * Used by:
 * - Extension to connect to Relay server
 * - Any client connecting to the hub network via WebSocket
 */

import { Transport, TransportState, HubEnvelope } from './types.js';

export interface ReconnectConfig {
  /** Initial delay before first reconnection attempt (ms) */
  initialDelay: number;

  /** Maximum delay between reconnection attempts (ms) */
  maxDelay: number;

  /** Backoff multiplier (e.g., 2 = double delay each retry) */
  backoffMultiplier: number;

  /** Max reconnect attempts (0 = infinite) */
  maxAttempts?: number;
}

export interface WebSocketTransportConfig {
  /** Transport name */
  name: string;

  /** WebSocket URL */
  url: string;

  /** Peer patterns reachable via this transport */
  peerPatterns?: string[];

  /** Reconnection strategy with exponential backoff */
  reconnect?: Partial<ReconnectConfig>;

  /** Registration message to send on connect */
  registrationMessage?: Record<string, any>;

  /**
   * Send a bare `{"type":"keepalive"}` frame this often (ms). An MV3 service worker is
   * suspended after 30s without events, and an idle socket is not an event; traffic on it
   * is. The relay ignores the frame.
   */
  keepAliveMs?: number;
}

type StateChangeHandler = (state: TransportState) => void;
type ReceiveHandler = (envelope: HubEnvelope) => void;

/** Close code the relay uses for a refused registration. */
const REFUSED = 4401;
/**
 * Close code the relay uses for a connection another one took the name of. Reconnecting
 * would take it back, and the other would do the same: two clients kicking each other out
 * every second.
 */
const REPLACED = 4410;

/** Default reconnection config */
const DEFAULT_RECONNECT: ReconnectConfig = {
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  maxAttempts: 0, // Infinite
};

export class WebSocketTransport implements Transport {
  readonly name: string;
  private readonly config: WebSocketTransportConfig;
  private readonly reconnectConfig: ReconnectConfig;
  private _state: TransportState = { connected: false };
  private _peerPatterns: string[];
  private ws: WebSocket | null = null;
  private receiveHandler: ReceiveHandler | null = null;
  private stateHandlers = new Set<StateChangeHandler>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Set between sending the registration and the relay's `registered`. */
  private awaitingRegistration: (() => void) | null = null;

  constructor(config: WebSocketTransportConfig) {
    this.name = config.name;
    this.config = config;
    this.reconnectConfig = {
      ...DEFAULT_RECONNECT,
      ...config.reconnect,
    };
    this._peerPatterns = config.peerPatterns ?? [];
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
    if (!this._state.connected || !this.ws) {
      return;
    }
    try {
      this.ws.send(JSON.stringify(envelope));
    } catch (e) {
      console.error(`[WebSocketTransport:${this.name}] Send error:`, e);
    }
  }

  onReceive(handler: ReceiveHandler): void {
    this.receiveHandler = handler;
  }

  onStateChange(handler: StateChangeHandler): void {
    this.stateHandlers.add(handler);
  }

  async connect(): Promise<void> {
    if (this._state.connected) {
      return;
    }

    this.intentionalClose = false;

    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(this.config.url);
        this.ws = ws;
        // Node's WebSocket (22) reports a refused connection with an error only — no close, and
        // readyState left at CONNECTING; a browser sends both. Whichever comes first ends this
        // socket, once.
        let ended = false;

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;

          // With a registration, the connection exists once the relay has ACCEPTED it, not
          // when the socket opens: a refused pairing code must fail connect(), and nothing
          // may be announced (the state change makes the node emit) before the relay
          // knows who we are — it drops a socket that sends ahead of its registration.
          if (this.config.registrationMessage) {
            this.awaitingRegistration = () => {
              this.awaitingRegistration = null;
              this.setState({ connected: true });
              this.startKeepAlive();
              resolve();
            };
            this.ws?.send(JSON.stringify(this.config.registrationMessage));
            return;
          }
          this.setState({ connected: true });
          this.startKeepAlive();

          resolve();
        };

        this.ws.onclose = (event) => {
          if (ended) return;
          ended = true;
          this.stopKeepAlive();
          // 4401: the relay refused the pairing code. Retrying with the same code cannot
          // succeed; the state says why, and a new code means a new transport.
          const wasRegistering = this.awaitingRegistration !== null;
          this.awaitingRegistration = null;
          if (event.code === REFUSED) {
            this.intentionalClose = true;
            this.setState({ connected: false, error: 'pairing code refused' });
            reject(new Error('pairing code refused'));
            return;
          }
          if (event.code === REPLACED) {
            this.intentionalClose = true;
            this.setState({ connected: false, error: 'replaced by a newer connection' });
            return;
          }
          // Closed before the relay accepted us: this attempt failed.
          if (wasRegistering) reject(new Error('connection closed before registration'));

          this.setState({ connected: false });

          // Reconnect unless intentionally closed
          if (!this.intentionalClose) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = () => {
          // Don't log - browser already logs the native error
          // Just reject the promise if not yet connected
          if (!this._state.connected) {
            reject(new Error('WebSocket connection failed'));
          }
          // A reconnect attempt that failed without a close: the next one is still due.
          if (!ended && !this._state.connected && ws.readyState !== WebSocket.OPEN && this.reconnectAttempts > 0 && !this.intentionalClose) {
            ended = true;
            this.setState({ connected: false });
            this.scheduleReconnect();
          }
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    if (!this.config.keepAliveMs) return;
    this.keepAliveTimer = setInterval(() => {
      if (this.ws?.readyState === 1) this.ws.send('{"type":"keepalive"}');
    }, this.config.keepAliveMs);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopKeepAlive();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setState({ connected: false });
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);

      // Handle relay protocol messages
      if (msg.type === 'registered') {
        this.awaitingRegistration?.();
        return;
      }
      if (msg.type === 'welcome' || msg.type === 'register-refused') {
        return;
      }

      if (msg.type === 'error') {
        console.error(`[WebSocketTransport:${this.name}] Server error:`, msg);
        return;
      }

      // Treat as hub envelope
      if (msg.id && msg.type) {
        this.receiveHandler?.(msg as HubEnvelope);
      }
    } catch (e) {
      console.error(`[WebSocketTransport:${this.name}] Parse error:`, e);
    }
  }

  private setState(state: TransportState): void {
    this._state = state;
    this.stateHandlers.forEach((h) => {
      try {
        h(state);
      } catch (e) {
        console.error(`[WebSocketTransport:${this.name}] State handler error:`, e);
      }
    });
  }

  /**
   * Calculate delay with exponential backoff
   * Formula: min(initialDelay * (multiplier ^ attempts), maxDelay)
   */
  private calculateBackoffDelay(): number {
    const { initialDelay, maxDelay, backoffMultiplier } = this.reconnectConfig;
    const delay = initialDelay * Math.pow(backoffMultiplier, this.reconnectAttempts);
    return Math.min(delay, maxDelay);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const maxAttempts = this.reconnectConfig.maxAttempts ?? 0;
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      console.warn(`[WebSocketTransport:${this.name}] Max reconnect attempts reached (${maxAttempts})`);
      this.setState({ connected: false, reconnecting: false });
      return;
    }

    const delay = this.calculateBackoffDelay();
    this.reconnectAttempts++;
    this.setState({ connected: false, reconnecting: true });

    // Use debug level - relay is optional dev tool, connection failures are normal
    console.debug(
      `[WebSocketTransport:${this.name}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Don't log reconnect failures - browser already logs the native error
      this.connect().catch(() => {});
    }, delay);
  }
}
