/**
 * WebSocket Server Transport - Manages multiple client connections for the relay
 *
 * This transport wraps a WebSocket server and manages all connected clients.
 * Each client registers with its nodeId and optional peer patterns.
 * The transport routes messages to appropriate clients based on target.
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { timingSafeEqual } from 'crypto';

export interface HubHop {
  node: string;
  transport?: string;
}

export interface HubEnvelope {
  id: string;
  type: string;
  payload: any;
  source: string;
  target: string;
  scope: 'local' | 'global';
  timestamp: number;
  replyToId?: string;
  vlan?: string;
  hops?: HubHop[];
  meta?: Record<string, any>;
}

export interface TransportState {
  connected: boolean;
  reconnecting?: boolean;
  error?: string;
}

export interface Transport {
  readonly name: string;
  readonly state: TransportState;
  readonly peerPatterns: string[];
  send(envelope: HubEnvelope): void;
  onReceive(handler: (envelope: HubEnvelope) => void): void;
  onStateChange(handler: (state: TransportState) => void): void;
  connect?(): Promise<void>;
  disconnect?(): void;
}

interface ClientInfo {
  ws: WebSocket;
  nodeId: string;
  peerPatterns: string[]; // What this client can reach (e.g., 'extension' can reach 'debug-panel')
  registeredAt: Date;
  metadata: Record<string, any>;
}

type ReceiveHandler = (envelope: HubEnvelope, fromClientId: string) => void;
type ClientEventHandler = (clientId: string, info: ClientInfo) => void;

export class WebSocketServerTransport implements Transport {
  readonly name = 'ws-server';
  private _state: TransportState = { connected: true };
  private _peerPatterns: string[] = ['*']; // Server can reach all connected clients

  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientInfo>();
  private clientsByNodeId = new Map<string, ClientInfo>();
  private receiveHandler: ReceiveHandler | null = null;
  private onClientConnectHandlers = new Set<ClientEventHandler>();
  private onClientDisconnectHandlers = new Set<ClientEventHandler>();
  private onClientCloseHandlers = new Set<(clientId: string, code: number, reason: string) => void>();

  /**
   * `securityKey`: the pairing code. When set, a client that registers without it — or
   * sends anything before registering — is closed. A loopback port is enumerable by any
   * process and any extension on the machine; the key is what makes it a session's.
   */
  constructor(wss: WebSocketServer, private readonly options: { securityKey?: string; quiet?: boolean } = {}) {
    this.wss = wss;
    this.setupServer();
  }

  private trace(message: string): void {
    if (!this.options.quiet) console.log(message);
  }

  private keyMatches(given: unknown): boolean {
    const expected = this.options.securityKey;
    if (expected === undefined) return true;
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  get state(): TransportState {
    return this._state;
  }

  get peerPatterns(): string[] {
    return this._peerPatterns;
  }

  /**
   * Get all connected client node IDs
   */
  getConnectedClients(): string[] {
    return Array.from(this.clientsByNodeId.keys());
  }

  /**
   * Get client info by node ID
   */
  getClientInfo(nodeId: string): ClientInfo | undefined {
    return this.clientsByNodeId.get(nodeId);
  }

  /**
   * Send envelope to target client(s)
   *
   * Routing logic:
   * - target='*' → broadcast to all clients
   * - target='specific-node' → send to that node only
   * - target='prefix:*' → send to nodes matching prefix
   */
  send(envelope: HubEnvelope): void {
    const { target } = envelope;

    if (target === '*') {
      // Broadcast to all except source
      this.broadcast(envelope, envelope.source);
    } else {
      // Smart routing
      const targetClients = this.findClientsForTarget(target, envelope.source);
      targetClients.forEach((client) => {
        this.sendToClient(client.ws, envelope);
      });
    }
  }

  onReceive(handler: ReceiveHandler): void {
    this.receiveHandler = handler;
  }

  onStateChange(_handler: (state: TransportState) => void): void {
    // Server is always "connected"
  }

  onClientConnect(handler: ClientEventHandler): void {
    this.onClientConnectHandlers.add(handler);
  }

  /** Every socket close of a known client, with its code: why a client went away. */
  onClientClose(handler: (clientId: string, code: number, reason: string) => void): void {
    this.onClientCloseHandlers.add(handler);
  }

  onClientDisconnect(handler: ClientEventHandler): void {
    this.onClientDisconnectHandlers.add(handler);
  }

  async connect(): Promise<void> {
    // Server is always connected
  }

  disconnect(): void {
    // Close all client connections
    this.clients.forEach((info, ws) => {
      ws.close();
    });
    this.clients.clear();
    this.clientsByNodeId.clear();
  }

  private setupServer(): void {
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const clientIp = req.socket.remoteAddress;
      this.trace(`[WSServerTransport] Client connected from ${clientIp}`);

      // Temporary client info until registration
      const tempInfo: ClientInfo = {
        ws,
        nodeId: `unregistered-${Date.now()}`,
        peerPatterns: [],
        registeredAt: new Date(),
        metadata: {},
      };
      this.clients.set(ws, tempInfo);

      // Send welcome message
      this.sendToClient(ws, {
        id: `welcome-${Date.now()}`,
        type: 'welcome',
        payload: { message: 'Connected to Hub Relay' },
        source: 'relay',
        target: tempInfo.nodeId,
        scope: 'local',
        timestamp: Date.now(),
      });

      ws.on('message', (data) => {
        this.handleMessage(ws, data);
      });

      ws.on('close', (code, reason) => {
        const who = this.clients.get(ws)?.nodeId;
        if (who) this.onClientCloseHandlers.forEach((h) => h(who, code, reason.toString()));
        this.handleDisconnect(ws);
      });

      ws.on('error', (err) => {
        console.error(`[WSServerTransport] Client error:`, err);
      });
    });
  }

  private handleMessage(ws: WebSocket, data: any): void {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.error('[WSServerTransport] Invalid JSON received');
      return;
    }

    const clientInfo = this.clients.get(ws);
    if (!clientInfo) {
      return;
    }

    // Handle registration
    if (msg.type === 'register') {
      this.handleRegistration(ws, clientInfo, msg);
      return;
    }

    // Nothing but a registration is accepted from a client that has not registered: an
    // envelope sent first would otherwise skip the key check entirely.
    if (this.clientsByNodeId.get(clientInfo.nodeId)?.ws !== ws) {
      ws.close(4401, 'register first');
      return;
    }

    // Handle hub envelope
    if (msg.id && msg.type) {
      // Ensure source is set to the registered nodeId
      const envelope: HubEnvelope = {
        ...msg,
        source: clientInfo.nodeId,
      };

      // Notify receive handler
      this.receiveHandler?.(envelope, clientInfo.nodeId);
    }
  }

  private handleRegistration(ws: WebSocket, clientInfo: ClientInfo, msg: any): void {
    if (!this.keyMatches(msg.securityKey)) {
      this.sendToClient(ws, {
        id: `refused-${Date.now()}`,
        type: 'register-refused',
        payload: { reason: 'wrong or missing pairing code' },
        source: 'relay',
        target: clientInfo.nodeId,
        scope: 'local',
        timestamp: Date.now(),
      });
      ws.close(4401, 'wrong or missing pairing code');
      return;
    }

    const nodeId = msg.nodeId || msg.client || `client-${Date.now()}`;
    const peerPatterns = msg.peerPatterns || [];

    // A name already held by a live connection is not handed over: whoever registered
    // `service:bushwhack` or a project's session would otherwise receive what is meant for
    // it — the pairing code alone must not let a client pose as another. The extension's
    // own names are the exception: a restarted service worker comes back under the same
    // name while its old socket still looks open, and that old socket is stale.
    const existing = this.clientsByNodeId.get(nodeId);
    if (existing && existing.ws !== ws) {
      const live = existing.ws.readyState === WebSocket.OPEN;
      if (live && !nodeId.startsWith('ext:')) {
        this.sendToClient(ws, {
          id: `refused-${Date.now()}`,
          type: 'register-refused',
          payload: { reason: `${nodeId} is already connected` },
          source: 'relay',
          target: nodeId,
          scope: 'local',
          timestamp: Date.now(),
        });
        ws.close(4409, 'name taken');
        return;
      }
      console.warn(`[WSServerTransport] Duplicate registration for ${nodeId}, closing stale connection`);
      this.clients.delete(existing.ws);
      // Its own code: the replaced client must not reconnect and take the name back.
      existing.ws.close(4410, 'replaced by a newer connection');
    }

    // Update client info
    clientInfo.nodeId = nodeId;
    clientInfo.peerPatterns = peerPatterns;
    clientInfo.metadata = {
      client: msg.client,
      botName: msg.botName,
      fingerprint: msg.fingerprint,
      extensionId: msg.extensionId,
      version: msg.extensionVersion || msg.version,
      taskTypes: msg.taskTypes,
      ...msg.metadata,
    };

    // Index by nodeId
    this.clientsByNodeId.set(nodeId, clientInfo);

    this.trace(`[WSServerTransport] Client registered: ${nodeId} (patterns: ${peerPatterns.join(', ') || 'none'})`);

    // Send registration confirmation
    this.sendToClient(ws, {
      id: `registered-${Date.now()}`,
      type: 'registered',
      payload: { status: 'ok', nodeId },
      source: 'relay',
      target: nodeId,
      scope: 'local',
      timestamp: Date.now(),
    });

    // Notify handlers
    this.onClientConnectHandlers.forEach((h) => h(nodeId, clientInfo));
  }

  private handleDisconnect(ws: WebSocket): void {
    const clientInfo = this.clients.get(ws);
    if (clientInfo) {
      this.trace(`[WSServerTransport] Client disconnected: ${clientInfo.nodeId}`);

      // Only remove from nodeId map if this ws is still the registered one
      // (prevents race condition where new connection re-registered before old close event)
      const currentRegistration = this.clientsByNodeId.get(clientInfo.nodeId);
      if (currentRegistration?.ws === ws) {
        this.clientsByNodeId.delete(clientInfo.nodeId);
        // Notify handlers only if we actually removed the registration
        this.onClientDisconnectHandlers.forEach((h) => h(clientInfo.nodeId, clientInfo));
      }

      this.clients.delete(ws);
    }
  }

  /**
   * Broadcast to clients within the same "hub"
   *
   * Hub isolation rules:
   * - MCP (mcp:*) is the bridge: can broadcast to all clients
   * - Non-MCP clients are isolated from each other (no cross-talk)
   * - This prevents extensions from receiving messages from other extensions
   */
  private broadcast(envelope: HubEnvelope, excludeSource?: string): void {
    const sourceIsMcp = excludeSource?.startsWith('mcp');

    this.clients.forEach((clientInfo) => {
      if (clientInfo.nodeId === excludeSource) return;

      // Non-MCP clients are isolated from each other
      // Only MCP can broadcast to everyone
      if (!sourceIsMcp && !clientInfo.nodeId.startsWith('mcp')) {
        return;
      }

      this.sendToClient(clientInfo.ws, envelope);
    });
  }

  private findClientsForTarget(target: string, excludeSource?: string): ClientInfo[] {
    const results: ClientInfo[] = [];

    // Direct match by nodeId
    const direct = this.clientsByNodeId.get(target);
    if (direct && direct.nodeId !== excludeSource) {
      return [direct];
    }

    // Pattern matching on nodeId only (e.g., 'mcp:*' matches 'mcp:default')
    // NOTE: We do NOT use peerPatterns for routing - those indicate what LOCAL
    // peers a client can reach, not what messages to forward to them.
    // This prevents cross-talk between extensions that register similar peerPatterns.
    this.clientsByNodeId.forEach((info) => {
      if (info.nodeId === excludeSource) return;

      // Check if this client's nodeId matches the target pattern
      if (this.matchesPattern(info.nodeId, target)) {
        results.push(info);
      }
    });

    // If no specific match found, return empty - don't broadcast to unrelated clients
    // This prevents cross-talk between separate extension instances
    return results;
  }

  private matchesPattern(value: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern === value) return true;
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -1); // 'mcp:*' → 'mcp:'
      return value.startsWith(prefix);
    }
    return false;
  }

  private sendToClient(ws: WebSocket, envelope: HubEnvelope): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(envelope));
    }
  }
}
