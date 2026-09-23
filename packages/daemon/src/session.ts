/**
 * A session is a folder. Its name comes from the folder; its state lives in it, in
 * `.bushwhack/` — invisible to every fs:* tool (like `.git/`), kept out of git through
 * `.git/info/exclude`, and gone with the folder. It holds the pairing code, the replay
 * store and the secret-file declarations: nothing in it may reach the chat.
 */
import { createHash, randomInt } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DECLARATIONS_TEMPLATE } from '@bushwhack/secrets';

export const STATE_DIR = '.bushwhack';

export interface SessionInfo {
  /** DNS-label slug of the folder name. */
  name: string;
  folder: string;
  stateDir: string;
  nodeId: string;
}

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return slug || 'session';
}

/** `folder` must already be a realpath. */
export function describeSession(folder: string): SessionInfo {
  const name = slugify(basename(folder));
  const hash = createHash('sha256').update(folder).digest('hex').slice(0, 8);
  return { name, folder, stateDir: join(folder, STATE_DIR), nodeId: `session:${name}-${hash}` };
}

/**
 * Where earlier versions kept a session's state: outside the project. Read once, to carry
 * the pairing code and replay store over, so an existing pairing survives the move.
 */
function legacyStateDir(session: SessionInfo, env: NodeJS.ProcessEnv): string {
  const hash = createHash('sha256').update(session.folder).digest('hex').slice(0, 8);
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'bushwhack', `${session.name}-${hash}`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Keep `.bushwhack/` out of git without touching the project's own .gitignore. */
async function excludeFromGit(folder: string): Promise<void> {
  const gitDir = join(folder, '.git');
  if (!(await stat(gitDir).then((s) => s.isDirectory(), () => false))) return;
  const exclude = join(gitDir, 'info', 'exclude');
  const current = await readFile(exclude, 'utf8').catch(() => '');
  if (current.split('\n').some((line) => line.trim() === `/${STATE_DIR}/`)) return;
  await mkdir(join(gitDir, 'info'), { recursive: true });
  await appendFile(exclude, `${current === '' || current.endsWith('\n') ? '' : '\n'}/${STATE_DIR}/\n`);
}

export async function ensureStateDir(session: SessionInfo, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await mkdir(session.stateDir, { recursive: true, mode: 0o700 });
  await excludeFromGit(session.folder);
  const declarations = join(session.stateDir, 'secrets.jsonc');
  if (!(await exists(declarations))) await writeFile(declarations, DECLARATIONS_TEMPLATE, { mode: 0o600 });
  const legacy = legacyStateDir(session, env);
  for (const file of ['pairing.json', 'calls.jsonl']) {
    const target = join(session.stateDir, file);
    if (!(await exists(target)) && (await exists(join(legacy, file)))) await copyFile(join(legacy, file), target);
  }
}

/** No 0/O, 1/I/L: the code is read off a terminal and typed into the extension's panel. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function newPairingCode(): string {
  const pick = (): string => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${pick()}-${pick()}-${pick()}`;
}

export interface Endpoint {
  port: number;
  pid: number;
  code: string;
}

/**
 * The pairing code survives a daemon restart — re-pairing the browser each time would
 * teach the operator to paste codes without reading them. `--new-code` rotates it.
 */
export async function loadPairingCode(session: SessionInfo, rotate: boolean): Promise<string> {
  const file = join(session.stateDir, 'pairing.json');
  if (!rotate) {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as { code?: unknown };
      if (typeof saved.code === 'string' && saved.code) return saved.code;
    } catch {
      // No code yet.
    }
  }
  const code = newPairingCode();
  await writeFile(file, JSON.stringify({ code }) + '\n', { mode: 0o600 });
  return code;
}

/** Where a running `serve` can be reached, for the CLI clients started in the same folder. */
export async function writeEndpoint(session: SessionInfo, endpoint: Endpoint): Promise<void> {
  await writeFile(join(session.stateDir, 'endpoint.json'), JSON.stringify(endpoint) + '\n', { mode: 0o600 });
}

export async function readEndpoint(session: SessionInfo): Promise<Endpoint | undefined> {
  try {
    return JSON.parse(await readFile(join(session.stateDir, 'endpoint.json'), 'utf8')) as Endpoint;
  } catch {
    return undefined;
  }
}
