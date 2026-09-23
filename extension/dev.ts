/**
 * Drive the development extension from a terminal, through the dev control relay that
 * `npm run ext:watch` hosts.
 *
 *   npm run ext:dev -- state
 *   npm run ext:dev -- open https://www.meta.ai/
 *   npm run ext:dev -- popup '{"type":"discover"}'
 *   npm run ext:dev -- tab <tabId> dump
 *   npm run ext:dev -- tab <tabId> type < message.txt
 *   npm run ext:dev -- tab <tabId> send
 *
 * Prints the extension's answer as JSON.
 *
 * With several development browsers on the relay, BUSHWHACK_EXT=<id> (environment, or the
 * git-ignored .env.local) picks one: the id in `ext:dev-<id>`, as `state` shows `ext:<id>`.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stdin } from 'node:process';
import { fileURLToPath } from 'node:url';
import { connectDev, devControl } from './dev-control.js';
import { EXTENSION_NODE_PREFIX } from '@bushwhack/protocol';
import { DEV_CALL, type DevCommand, type PopupRequest, type TabCommand } from './src/messages.js';

const localEnv = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
if (existsSync(localEnv)) process.loadEnvFile(localEnv);

/** One extension, or any: the relay matches `prefix:*` patterns, and carries only dev extensions. */
function target(): string {
  const id = process.env.BUSHWHACK_EXT?.replace(/^ext:(dev-)?/, '');
  return id ? `${EXTENSION_NODE_PREFIX}dev-${id}` : `${EXTENSION_NODE_PREFIX}*`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\n$/, '');
}

async function command(argv: string[]): Promise<DevCommand> {
  const [action, ...rest] = argv;
  switch (action) {
    case 'state':
      return { action: 'state' };
    case 'open':
      return { action: 'open', url: rest[0] };
    case 'reload-tab':
      return { action: 'reload-tab', tabId: Number(rest[0]) };
    case 'popup':
      return { action: 'popup', request: JSON.parse(rest[0]) as PopupRequest };
    case 'tab': {
      const tabId = Number(rest[0]);
      const what = rest[1];
      let tabCommand: TabCommand;
      if (what === 'dump') tabCommand = { type: 'dev:dump' };
      else if (what === 'send') tabCommand = { type: 'dev:send' };
      else if (what === 'poke') tabCommand = { type: 'dev:poke' };
      else if (what === 'image') tabCommand = { type: 'dev:image' };
      else if (what === 'panel') tabCommand = { type: 'panel', tabId };
      else if (what === 'answer') tabCommand = { type: 'dev:answer' };
      else if (what === 'probe') tabCommand = { type: 'dev:probe', selector: rest[2] ?? 'body' };
      else if (what === 'click') tabCommand = { type: 'dev:click', selector: rest[2] ?? '' };
      else if (what === 'copy') tabCommand = { type: 'dev:copy', fromEnd: Number(rest[2] ?? 0) };
      else if (what === 'type') tabCommand = { type: 'dev:type', text: rest[2] ?? (await readStdin()) };
      else throw new Error('tab <tabId> dump|type|send|copy [fromEnd]|poke|image|panel|probe <selector>|click <selector>');
      return { action: 'tab', tabId, command: tabCommand };
    }
    default:
      throw new Error('usage: state | open <url> | reload-tab <tabId> | popup <json> | tab <tabId> dump|type|send');
  }
}

async function main(): Promise<void> {
  const cmd = await command(process.argv.slice(2));
  const client = await connectDev(await devControl(), 'dev-cli');
  try {
    const reply = await client.node.request(DEV_CALL, cmd, { target: target(), timeoutMs: 30_000 });
    console.log(JSON.stringify(reply.payload, null, 2));
  } finally {
    client.close();
  }
}

main().catch((e: unknown) => {
  console.error(`ext:dev: ${(e as Error).message}`);
  process.exit(1);
});
