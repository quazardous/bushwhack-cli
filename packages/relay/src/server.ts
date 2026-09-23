/**
 * Bushwhack relay server
 *
 * A hub node that acts as a message broker for the hub network.
 * Clients connect via WebSocket and register with their nodeId.
 * Messages are routed based on target patterns.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'http';
import { createServer as createHttpsServer } from 'https';
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { WebSocketServerTransport, HubEnvelope } from './ws-server-transport.js';

export interface TlsConfig {
  cert: string;  // Path to certificate file
  key: string;   // Path to private key file
}

export interface RelayConfig {
  port: number;
  /** Interface to bind. Loopback unless said otherwise: the relay is a local bus. */
  host?: string;
  logDir: string;
  /** The pairing code; see WebSocketServerTransport. */
  securityKey?: string;
  version: string;
  tls?: TlsConfig;  // If provided, enables WSS
  /** Extra facts for `/health`, so a client probing ports can tell whose relay this is. */
  health?: Record<string, unknown>;
  /** Log to the log file only, not to the console: the daemon owns its terminal. */
  quiet?: boolean;
}

export class RelayServer {
  private server: any;
  private wss: WebSocketServer;
  private transport: WebSocketServerTransport;
  private knownChannels = new Set<string>();

  constructor(private config: RelayConfig) {
    this.ensureLogDir();

    // Create HTTP or HTTPS server based on TLS config
    if (config.tls) {
      const tlsOptions = {
        cert: readFileSync(config.tls.cert),
        key: readFileSync(config.tls.key),
      };
      this.server = createHttpsServer(tlsOptions, this.handleHttpRequest.bind(this));
      this.log(`TLS enabled (cert: ${config.tls.cert})`);
    } else {
      this.server = createHttpServer(this.handleHttpRequest.bind(this));
    }

    this.wss = new WebSocketServer({ server: this.server });
    // `ws` re-emits the HTTP server's errors here; unheard, an EADDRINUSE would throw
    // instead of rejecting listen().
    this.wss.on('error', () => {});

    // Create the WebSocket server transport
    this.transport = new WebSocketServerTransport(this.wss, { securityKey: config.securityKey, quiet: config.quiet });
    this.setupTransport();
  }

  private ensureLogDir() {
    if (!existsSync(this.config.logDir)) {
      mkdirSync(this.config.logDir, { recursive: true });
    }
  }

  private log(message: string) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}`;
    if (!this.config.quiet) console.log(line);
    this.writeToFile(join(this.config.logDir, 'relay.log'), line);
  }

  private writeToFile(filePath: string, line: string) {
    try {
      this.ensureLogDir();
      appendFileSync(filePath, line + '\n');
    } catch (err: any) {
      console.error(`[!] Failed to write log: ${err.message}`);
    }
  }

  /**
   * Write log entry to channel file
   *
   * Supports both old format (time, data) and new LogEntry format (timestamp, context, source)
   */
  private logToChannel(entry: any) {
    const channel = entry.channel || 'default';
    const safeChannel = channel.replace(/[^a-z0-9_-]/gi, '_');

    if (!this.knownChannels.has(safeChannel)) {
      this.knownChannels.add(safeChannel);
      this.log(`New log channel: ${channel} -> ${safeChannel}.log`);
    }

    // Support both old (time) and new (timestamp) format
    const timestamp = entry.timestamp
      ? new Date(entry.timestamp).toISOString()
      : (entry.time || new Date().toISOString());

    const level = (entry.level || 'info').toUpperCase();
    const source = entry.source || 'unknown';
    const message = entry.message || '';

    // Format: [timestamp] [LEVEL] [source] message {context}
    let line = `[${timestamp}] [${level}] [${source}] ${message}`;

    // Support both old (data) and new (context) format
    const contextData = entry.context || entry.data;
    if (contextData && Object.keys(contextData).length > 0) {
      line += ` ${JSON.stringify(contextData)}`;
    }

    this.writeToFile(join(this.config.logDir, `${safeChannel}.log`), line);
  }

  private setupTransport() {
    // Handle incoming messages from clients
    this.transport.onReceive((envelope: HubEnvelope, fromClientId: string) => {
      // Persist @log messages to channel files, then continue to forward
      if (envelope.type === '@log' && envelope.payload) {
        this.logToChannel(envelope.payload);
      }

      // Log non-log messages for debugging
      this.log(`[MSG] ${fromClientId} -> ${envelope.type} (target: ${envelope.target}, id: ${envelope.id})`);

      // Forward to other clients (relay acts as a simple broadcaster)
      this.transport.send(envelope);
    });

    // Handle client connect/disconnect
    this.transport.onClientConnect((nodeId, info) => {
      const clients = this.transport.getConnectedClients();
      this.log(`[+] Client registered: ${nodeId} (total: ${clients.length})`);
      if (info.metadata?.version) {
        this.log(`    Version: ${info.metadata.version}`);
      }
      if (info.metadata?.taskTypes?.length) {
        this.log(`    Task types: ${info.metadata.taskTypes.join(', ')}`);
      }
    });

    this.transport.onClientClose((nodeId, code, reason) => {
      this.log(`[x] ${nodeId} closed its socket: code ${code}${reason ? ` (${reason})` : ''}`);
    });

    this.transport.onClientDisconnect((nodeId) => {
      const clients = this.transport.getConnectedClients();
      this.log(`[-] Client disconnected: ${nodeId} (remaining: ${clients.length})`);
    });
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    const url = req.url;

    // No CORS headers, on purpose: `/health` names the project folder, and no web page
    // has any business reading it. The extension's service worker reads it through its
    // host permissions, which need no CORS.

    if (url === '/health' || url === '/hello') {
      const clients = this.transport.getConnectedClients();
      // An extension registers under its own node id, never under the
      // literal nodeId 'extension': find it by the client kind it declares.
      const extensionInfo = clients
        .map((nodeId) => this.transport.getClientInfo(nodeId))
        .find((info) => info?.metadata?.client === 'extension');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        ...this.config.health,
        relayVersion: this.config.version,
        tls: !!this.config.tls,
        clients: clients.length,
        connectedClients: clients,
        extension: !!extensionInfo,
        extensionVersion: extensionInfo?.metadata?.version || null,
        taskTypes: extensionInfo?.metadata?.taskTypes || [],
        connectedAt: extensionInfo?.registeredAt?.toISOString() || null,
      }));
    } else if (url === '/channels') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        channels: Array.from(this.knownChannels),
        logDir: this.config.logDir,
      }));
    } else if (url === '/clients') {
      // List all connected clients with metadata
      const clients = this.transport.getConnectedClients();
      const clientDetails = clients.map((nodeId) => {
        const info = this.transport.getClientInfo(nodeId);
        return {
          nodeId,
          type: info?.metadata?.client || 'unknown',
          name: info?.metadata?.botName || info?.metadata?.name || nodeId,
          version: info?.metadata?.version || null,
          extensionId: info?.metadata?.extensionId || null,
          fingerprint: info?.metadata?.fingerprint || null,
          taskTypes: info?.metadata?.taskTypes || [],
          connectedAt: info?.registeredAt?.toISOString() || null,
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        count: clientDetails.length,
        clients: clientDetails,
      }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  /** Rejects when the port is taken, so a caller can try the next one. */
  /** The clients connected now, with what each declared when it registered. */
  connected(): { nodeId: string; type: string; name: string; fingerprint: string | null }[] {
    return this.transport.getConnectedClients().map((nodeId) => {
      const info = this.transport.getClientInfo(nodeId);
      return {
        nodeId,
        type: info?.metadata?.client || 'unknown',
        name: info?.metadata?.botName || info?.metadata?.name || nodeId,
        fingerprint: info?.metadata?.fingerprint || null,
      };
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host ?? '127.0.0.1', () => {
        const protocol = this.config.tls ? 'wss' : 'ws';
        this.log(`Relay server listening on ${protocol}://${this.config.host ?? '127.0.0.1'}:${this.config.port}`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.transport.disconnect();
      this.server.close(() => {
        this.log('Relay server closed');
        resolve();
      });
    });
  }
}

export function createRelayServer(config: Partial<RelayConfig>) {
  const fullConfig: RelayConfig = {
    port: 3456,
    logDir: '/tmp/bushwhack-relay',
    version: '0.2.0',
    ...config,
  };

  const server = new RelayServer(fullConfig);

  // Start listening
  server.listen();

  return server;
}
