/**
 * The CLI's side of the service: find it, start it when it is not there, and talk to it
 * as the operator.
 *
 * Starting: through systemd's user manager when there is one (a unit is installed the
 * first time: `~/.config/systemd/user/bushwhack.service`), else as a detached process.
 * Either way the command waits until the service answers on its relay.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubNode, WebSocketTransport } from '@bushwhack/hub';
import { DEFAULT_INSTANCE, instanceDir, readServiceFile, SERVICE, SERVICE_NODE, type ServiceFile } from './service.js';

/** The bushwhack command itself: what the unit runs. */
export const BUSHWHACK_BIN = fileURLToPath(new URL('../../../bin/bushwhack', import.meta.url));
export const UNIT = 'bushwhack.service';

/** The default instance has its own unit; the others are instances of a template, `bushwhack@<name>`. */
export function unitName(instance: string = DEFAULT_INSTANCE): string {
  return instance === DEFAULT_INSTANCE ? UNIT : `bushwhack@${instance}.service`;
}

export function unitPath(env: NodeJS.ProcessEnv = process.env, instance: string = DEFAULT_INSTANCE): string {
  const file = instance === DEFAULT_INSTANCE ? UNIT : 'bushwhack@.service';
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', file);
}

/**
 * The user unit. PATH is the one of the shell that installed it: the service runs octopod
 * and docker, which systemd's own PATH may not reach.
 */
export function unitFile(bin: string, env: NodeJS.ProcessEnv = process.env, instance: string = DEFAULT_INSTANCE): string {
  const template = instance !== DEFAULT_INSTANCE;
  const lines = [
    '[Unit]',
    `Description=bushwhack — web chats working on your projects${template ? ' (instance %i)' : ''}`,
    '',
    '[Service]',
    `ExecStart=${bin} daemon${template ? ' --instance %i' : ''}`,
    `Environment=PATH=${env.PATH ?? '/usr/bin:/bin'}`,
    ...(env.BUSHWHACK_OCTOPOD ? [`Environment=BUSHWHACK_OCTOPOD=${env.BUSHWHACK_OCTOPOD}`] : []),
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return lines.join('\n');
}

async function answers(file: ServiceFile | undefined): Promise<boolean> {
  if (!file?.port) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${file.port}/health`, { signal: AbortSignal.timeout(500) });
    const body = (await response.json()) as { daemon?: string };
    return body.daemon === file.id;
  } catch {
    return false;
  }
}

function systemdUser(): boolean {
  return spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0;
}

/** Start it: systemd's user manager when there is one, a detached process otherwise. Says how. */
export async function startServiceProcess(dir: string, env: NodeJS.ProcessEnv = process.env, instance: string = DEFAULT_INSTANCE): Promise<string> {
  const UNIT = unitName(instance);
  if (systemdUser()) {
    const path = unitPath(env, instance);
    const wanted = unitFile(BUSHWHACK_BIN, env, instance);
    const current = await readFile(path, 'utf8').catch(() => undefined);
    if (current !== wanted) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, wanted);
      spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    }
    const started = spawnSync('systemctl', ['--user', 'start', UNIT], { encoding: 'utf8' });
    if (started.status !== 0) throw new Error(`systemctl --user start ${UNIT} failed: ${started.stderr.trim()}`);
    return `systemd (systemctl --user status ${UNIT}; journalctl --user -u ${UNIT})`;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const log = openSync(join(dir, 'service.log'), 'a');
  const child = spawn(BUSHWHACK_BIN, ['daemon', '--instance', instance], { detached: true, stdio: ['ignore', log, log], env });
  child.unref();
  return `a background process (log: ${join(dir, 'service.log')})`;
}

export interface Reached {
  file: ServiceFile;
  /** How it was started, when this call started it. */
  started?: string;
}

/** The service, answering: started first when it is not. */
export async function ensureService(
  options: { instance?: string; dir?: string; env?: NodeJS.ProcessEnv; start?: (dir: string) => Promise<string>; waitMs?: number } = {},
): Promise<Reached> {
  const instance = options.instance ?? DEFAULT_INSTANCE;
  const dir = options.dir ?? instanceDir(instance, options.env);
  const existing = await readServiceFile(dir);
  if (await answers(existing)) return { file: existing! };
  const how = await (options.start ?? ((d) => startServiceProcess(d, options.env, instance)))(dir);
  const until = Date.now() + (options.waitMs ?? 15_000);
  while (Date.now() < until) {
    const file = await readServiceFile(dir);
    if (await answers(file)) return { file: file!, started: how };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the bushwhack service did not answer after starting it through ${how}`);
}

/** A client of the service, acting for the operator. */
/**
 * A terminal that stays open (chat, approvals) passes `keep`: it reconnects for as long as
 * it runs — the service may be restarted under it — and `back` runs once it is connected
 * again, to take back what the new service does not know (the chat followed, the approvals).
 */
export interface KeepConnected {
  lost?: () => void;
  back?: () => void | Promise<void>;
}

export async function operatorClient(file: ServiceFile, nodeId: string, keep?: KeepConnected) {
  const node = new HubNode({ nodeId, defaultScope: 'global' });
  const transport = new WebSocketTransport({
    name: 'relay',
    url: `ws://127.0.0.1:${file.port}`,
    peerPatterns: ['*'],
    reconnect: keep ? { maxAttempts: 0, maxDelay: 3000 } : { maxAttempts: 1 },
    registrationMessage: { type: 'register', nodeId, securityKey: file.code, client: 'cli' },
  });
  node.addTransport(transport);
  await transport.connect();
  if (keep) {
    let connected = true;
    // A service coming back listens before its own node is there and before its projects
    // are: what `back` asks may fail at first. It is asked again until it passes.
    const takeBack = async (): Promise<void> => {
      for (let attempt = 0; connected && attempt < 60; attempt++) {
        try {
          await keep.back?.();
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    transport.onStateChange((state) => {
      if (state.connected === connected) return;
      connected = state.connected;
      if (!connected) keep.lost?.();
      else void takeBack();
    });
  }
  const ask = async (type: string, payload: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<Record<string, unknown>> => {
    const reply = (await node.request(type, { key: file.operatorKey, ...payload }, { target: SERVICE_NODE, timeoutMs })).payload as Record<string, unknown>;
    if (typeof reply?.error === 'string') throw new Error(reply.error);
    return reply;
  };
  return {
    node,
    add: (folder: string) => ask(SERVICE.add, { folder }),
    remove: (folder: string) => ask(SERVICE.remove, { folder }),
    list: () => ask(SERVICE.list),
    /** Take the approvals: from now on they come to this client. */
    approvalsHere: () => ask(SERVICE.approvalsHere, {}, 5000),
    /** Follow a project's chat: its chat:event messages come to this client. */
    chatAttach: (session: string) => ask(SERVICE.chatAttach, { session }, 5000),
    /** Send a prompt to a project's chat, through the extension. */
    chatSend: (session: string, text: string) => ask(SERVICE.chatSend, { session, text }),
    /** Send the tools manifest to a project's chat, made by the extension for that chat. */
    chatManifest: (session: string) => ask(SERVICE.chatSend, { session, text: '', manifest: true }),
    close: () => transport.disconnect(),
  };
}
