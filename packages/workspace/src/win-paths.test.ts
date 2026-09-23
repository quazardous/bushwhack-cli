/**
 * The jail on Windows: every name NTFS reads as another name, or as a device, is refused —
 * and `.git` / `.bushwhack` are hidden under any case, on every system. Each guard has its
 * case here: removing one fails a test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comparableName, windowsNameProblem } from './win-paths.js';
import { Workspace } from './workspace.js';

describe('Windows names', () => {
  it('says what is wrong with each kind', () => {
    expect(windowsNameProblem('.env::$DATA')).toMatch(/NTFS stream/);
    expect(windowsNameProblem('notes.txt:hidden')).toMatch(/NTFS stream/);
    expect(windowsNameProblem('.git.')).toMatch(/trailing dot/);
    expect(windowsNameProblem('.env ')).toMatch(/trailing dot or space/);
    expect(windowsNameProblem('NUL')).toMatch(/reserved/);
    expect(windowsNameProblem('nul.txt')).toMatch(/reserved/);
    expect(windowsNameProblem('com1.log')).toMatch(/reserved/);
    expect(windowsNameProblem('LPT9')).toMatch(/reserved/);
    expect(windowsNameProblem('BUSHWH~1')).toMatch(/8\.3/);
    for (const plain of ['src', 'index.html', '.env', 'console.log', 'nullable.ts', 'a.b.c', '.', '..']) expect(windowsNameProblem(plain), plain).toBeUndefined();
  });

  it('compares as NTFS does', () => {
    expect(comparableName('.GIT')).toBe('.git');
    expect(comparableName('.Bushwhack. ')).toBe('.bushwhack');
  });
});

describe('the jail', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bw-winjail-'));
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git/config'), '[remote] url = https://token@example.com\n');
    await writeFile(join(root, '.env'), 'KEY=secret\n');
    await writeFile(join(root, '.gitignore'), '.env\n');
    await writeFile(join(root, 'readme.md'), '# hi\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('on Windows, refuses every name that is another name or a device', async () => {
    const ws = await Workspace.open(root, { platform: 'win32' });
    for (const path of ['.env::$DATA', '.env:x', '.git./config', '.env ', 'NUL', 'docs/nul.txt', 'BUSHWH~1/calls.jsonl', 'src/CON']) {
      await expect(ws.resolve(path), path).rejects.toThrow(/not a name this project can hold on Windows/);
      await expect(ws.write(path, 'x'), path).rejects.toThrow(/not a name this project can hold on Windows/);
    }
    expect((await ws.read('readme.md', 1, 10)).text).toContain('# hi');
  });

  it('elsewhere, those names are plain names', async () => {
    const ws = await Workspace.open(root, { platform: 'linux' });
    await expect(ws.write('notes.txt:v2', 'x')).resolves.toMatchObject({ created: true });
  });

  it('hides .git and .bushwhack under any case, on every system', async () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      const ws = await Workspace.open(root, { platform });
      await expect(ws.write('.GIT/hooks/pre-commit', 'rm -rf ~'), platform).rejects.toThrow(/ignored \(or inside \.git\)/);
      await expect(ws.write('.Bushwhack/x', 'x'), platform).rejects.toThrow(/ignored \(or inside \.git\)/);
      await expect(ws.read('.GIT/config', 1, 10), platform).rejects.toThrow(/does not exist/);
    }
  });

  it('keeps ignore rules whatever the case', async () => {
    const ws = await Workspace.open(root, { platform: 'win32' });
    await expect(ws.write('.ENV', 'x')).rejects.toThrow(/ignored/);
  });
});
