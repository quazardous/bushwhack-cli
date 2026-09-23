/**
 * Declared secret files: the chat sees their shape, never a value, and cannot change them
 * through the ordinary tools. Each test names a way around that, and was checked to fail
 * with its guard removed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from './workspace.js';

let root: string;
let ws: Workspace;

const ENV = 'STRIPE_KEY=sk_live_abcdef\nPORT=3000\nEMPTY=\n';

async function put(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true });
  await writeFile(join(root, rel), content);
}

async function declare(files: Record<string, unknown>): Promise<void> {
  await put('.bushwhack/secrets.jsonc', `// declared by the operator\n${JSON.stringify({ files })}`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bw-secrets-'));
  await put('.gitignore', '.env\n');
  await put('app/.gitignore', '.env\n');
  await put('app/.env', ENV);
  await put('.env', 'UNDECLARED=hidden-value-1\n');
  await declare({ 'app/.env': { format: 'dotenv' } });
  ws = await Workspace.open(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a declared secret file', () => {
  it('is visible even though git ignores it, with every value scrambled', async () => {
    const read = await ws.read('app/.env', 1, 100);
    expect(read.text).toBe('STRIPE_KEY=‹secret:STRIPE_KEY›\nPORT=‹secret:PORT›\nEMPTY=');
    expect((await ws.list('app', 1)).text).toContain('.env');
  });

  it('is scrambled through a symlink with an innocent name too', async () => {
    await symlink(join(root, 'app/.env'), join(root, 'config.txt'));
    expect((await ws.read('config.txt', 1, 10)).text).not.toContain('sk_live');
  });

  it('cannot be searched for a value — a match would tell it', async () => {
    expect((await ws.search('sk_live', '.', false)).matches).toBe(0);
    expect((await ws.search('STRIPE_KEY', '.', false)).text).toContain('app/.env:1:');
  });

  it('is never written by the ordinary tools, directly, by a move or through a symlink', async () => {
    await expect(ws.write('app/.env', 'STRIPE_KEY=x')).rejects.toThrow(/declared secret file/);
    await expect(ws.edit('app/.env', [{ search: 'PORT', replace: 'P' }])).rejects.toThrow(/declared secret file/);
    await expect(ws.delete('app/.env')).rejects.toThrow(/declared secret file/);
    await expect(ws.move('app/.env', 'leak.txt')).rejects.toThrow(/declared secret file/);
    await put('decoy.txt', 'STRIPE_KEY=mine');
    await expect(ws.move('decoy.txt', 'app/.env')).rejects.toThrow(/declared secret file/);
    await symlink(join(root, 'app/.env'), join(root, 'alias.env'));
    await expect(ws.write('alias.env', 'x')).rejects.toThrow(/symlink|declared secret file/);
    expect(await readFile(join(root, 'app/.env'), 'utf8')).toBe(ENV);
  });
});

describe('what is not declared', () => {
  it('follows the ordinary rules: an ignored .env stays invisible', async () => {
    await expect(ws.read('.env', 1, 10)).rejects.toThrow(/does not exist/);
  });

  it('cannot be declared into .bushwhack/ or .git/', async () => {
    await put('.bushwhack/extra.env', 'A=1\n');
    await declare({ 'app/.env': { format: 'dotenv' }, '.bushwhack/extra.env': { format: 'dotenv' } });
    await expect(ws.read('.bushwhack/extra.env', 1, 10)).rejects.toThrow(/does not exist/);
  });
});

describe('masking elsewhere', () => {
  it('masks a declared value wherever it shows up, and leaves short values alone', async () => {
    const redact = await ws.secrets.redactor();
    expect(redact('key is sk_live_abcdef, port 3000')).toBe('key is ‹secret:STRIPE_KEY›, port 3000');
  });
});

describe('the raw file, for the secret:* tools', () => {
  it('reads and writes the real values, and creates a new file readable by its owner only', async () => {
    const file = await ws.secretFile('app/.env');
    expect(await file.read()).toBe(ENV);

    await declare({ 'app/.env': { format: 'dotenv' }, 'api/.env': { format: 'dotenv' } });
    const fresh = await ws.secretFile('api/.env');
    await fresh.write('TOKEN=abc\n');
    // Windows has no such mode bits: node reports every file as 0o666 there.
    if (process.platform !== 'win32') expect((await stat(join(root, 'api/.env'))).mode & 0o777).toBe(0o600);
  });

  it('refuses a file that is not declared', async () => {
    await expect(ws.secretFile('.env')).rejects.toThrow(/not a declared secret file/);
  });
});

describe('declarations', () => {
  it('refuse a path outside the project, or an unknown format', async () => {
    await put('README.md', '# readme\n');
    await declare({ '../outside.env': { format: 'dotenv' } });
    await expect(ws.read('README.md', 1, 1)).rejects.toThrow(/not a path inside the project/);
    await declare({ 'app/.env': { format: 'yaml' } });
    await expect(ws.read('app/.env', 1, 1)).rejects.toThrow(/format must be "dotenv"/);
  });
});
