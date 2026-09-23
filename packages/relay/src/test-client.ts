/**
 * Test helpers shared by the relay's vitest suites: a real WebSocket client that
 * registers the way extensions and MCP clients do.
 */

import { WebSocket } from 'ws';
import type { HubEnvelope } from './ws-server-transport.js';

const REGISTRATION_TIMEOUT_MS = 5000;

/**
 * Connect a client and register it; resolves once the relay confirms.
 * `metadata` is spread into the registration message (client, taskTypes, …).
 */
export async function connectClient(
  port: number,
  nodeId: string,
  peerPatterns: string[] = [],
  metadata: Record<string, unknown> = {},
): Promise<{ ws: WebSocket; messages: HubEnvelope[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages: HubEnvelope[] = [];
    const timer = setTimeout(
      () => reject(new Error('Connection timeout')),
      REGISTRATION_TIMEOUT_MS,
    );

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'register',
          nodeId,
          peerPatterns,
          ...metadata,
        }),
      );
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'registered') {
        clearTimeout(timer);
        resolve({ ws, messages });
      } else if (msg.type !== 'welcome') {
        // Collect non-protocol messages
        messages.push(msg);
      }
    });

    // A refused registration ends in a close, not a timeout.
    ws.on('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`closed ${code}`));
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Wait for messages to propagate */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
