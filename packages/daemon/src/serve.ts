/**
 * `bushwhack serve`: one process that owns one session — the relay on its port, the hub
 * node the extension talks to, the tools, the replay store and the terminal prompt. The
 * service (`bushwhack daemon`) does the same for every project on one relay.
 */
import { join } from 'node:path';
import { rangePorts, type SessionHealth } from '@bushwhack/protocol';
import { RelayServer } from '@bushwhack/relay';
import { octopodCli, type OctopodClient } from './octopod-client.js';
import { TerminalApprover } from './approval.js';
import type { Approver } from './dispatcher.js';
import { loadPairingCode, writeEndpoint, type SessionInfo } from './session.js';
import { openSession, prepareSession } from './session-node.js';

import { VERSION } from './version.js';

export { VERSION };

export interface ServeOptions {
  folder: string;
  rotateCode?: boolean;
  /** Replaces the terminal prompt (tests, or a future non-interactive policy). */
  approver?: Approver;
  /** Ports to try, in order. Defaults to the shared range. */
  ports?: number[];
  out?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** How the app:* tools reach octopod; its CLI by default. Tools are offered only if it answers. */
  octopod?: OctopodClient;
}

export interface Serving {
  session: SessionInfo;
  port: number;
  code: string;
  close(): Promise<void>;
}

export class AlreadyServing extends Error {}

export async function healthOf(port: number): Promise<Partial<SessionHealth> | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return (await response.json()) as Partial<SessionHealth>;
  } catch {
    return undefined;
  }
}

/** The first free port of the range, with a relay on it; refuses a folder already served. */
export async function listenRelay(options: { ports?: number[]; code: string; logDir: string; health: Record<string, unknown>; folder?: string }): Promise<{ relay: RelayServer; port: number }> {
  for (const candidate of options.ports ?? rangePorts()) {
    const attempt = new RelayServer({ port: candidate, logDir: options.logDir, securityKey: options.code, version: VERSION, quiet: true, health: options.health });
    try {
      await attempt.listen();
      return { relay: attempt, port: candidate };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      const other = await healthOf(candidate);
      const served = other?.folder === options.folder || (other?.sessions ?? []).some((s) => s.folder === options.folder);
      if (options.folder && other?.service === 'bushwhack' && served) {
        throw new AlreadyServing(`already serving ${options.folder} on port ${candidate}`);
      }
    }
  }
  throw new Error('no free port in the bushwhack range');
}

export async function serve(options: ServeOptions): Promise<Serving> {
  const out = options.out ?? ((line: string) => console.log(line));
  const { session } = await prepareSession(options.folder, options.env);
  const code = await loadPairingCode(session, options.rotateCode ?? false);
  const health: SessionHealth = { service: 'bushwhack', session: session.name, folder: session.folder, nodeId: session.nodeId };
  const { relay, port } = await listenRelay({ ports: options.ports, code, logDir: join(session.stateDir, 'logs'), health: { ...health }, folder: session.folder });
  const opened = await openSession({
    folder: options.folder,
    relay: { port, code },
    approver: (workspace, preview) => options.approver ?? new TerminalApprover(workspace, process.stdin, process.stdout, preview as never),
    octopod: options.octopod ?? octopodCli(),
    env: options.env,
    out,
  });
  out(`  app       ${opened.appLine}`);
  await writeEndpoint(session, { port, pid: process.pid, code });
  return {
    session,
    port,
    code,
    async close() {
      opened.close();
      await relay.close();
    },
  };
}
