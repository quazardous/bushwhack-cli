/**
 * The development control channel, shared by the build (which hosts it) and the terminal
 * client (which drives the extension through it). Development only: production builds
 * carry no dev.json and no code that reads one.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HubNode, WebSocketTransport } from '@bushwhack/hub';

/** Just below the sessions' range, so it is never taken by a session. */
export const DEV_PORT = 47299;

export interface DevControl {
  port: number;
  key: string;
}

function stateRoot(): string {
  return join(process.env.XDG_STATE_HOME || join(process.env.HOME ?? '', '.local', 'state'), 'bushwhack');
}

/** The channel's port and key, created on first use and kept (0600) so rebuilds do not re-pair. */
export async function devControl(): Promise<DevControl> {
  const file = join(stateRoot(), 'dev-control.json');
  try {
    return JSON.parse(await readFile(file, 'utf8')) as DevControl;
  } catch {
    const control = { port: DEV_PORT, key: randomBytes(18).toString('base64url') };
    await mkdir(stateRoot(), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(control) + '\n', { mode: 0o600 });
    return control;
  }
}

export async function connectDev(control: DevControl, name: string): Promise<{ node: HubNode; close(): void }> {
  const nodeId = `${name}:${process.pid}`;
  const node = new HubNode({ nodeId, defaultScope: 'global' });
  const transport = new WebSocketTransport({
    name: 'dev-control',
    url: `ws://127.0.0.1:${control.port}`,
    peerPatterns: ['*'],
    reconnect: { maxAttempts: 1 },
    registrationMessage: { type: 'register', nodeId, securityKey: control.key, client: name },
  });
  node.addTransport(transport);
  await transport.connect();
  // Let the relay register us before the first envelope.
  await new Promise((r) => setTimeout(r, 50));
  return { node, close: () => transport.disconnect() };
}
