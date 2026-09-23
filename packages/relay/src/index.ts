/**
 * @bushwhack/relay — the local WebSocket bus between the browser extension and the
 * session daemon.
 *
 * No binary here on purpose: `RelayServer` is a class the daemon embeds, so one process
 * owns the port, the session and the terminal prompt.
 */
export { RelayServer, createRelayServer } from './server.js';
export type { RelayConfig, TlsConfig } from './server.js';
export { WebSocketServerTransport } from './ws-server-transport.js';
export type { HubEnvelope } from './ws-server-transport.js';
