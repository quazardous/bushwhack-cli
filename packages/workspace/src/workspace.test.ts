/**
 * The jail and the ignore rules, which are the whole of this package's safety. Every
 * refusal here has a way around it that the test names; each was checked to fail with
 * its guard removed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, parseEdits } from './workspace.js';
import { runFsTool } from './tools.js';

let base: string;
let root: string;
let ws: Workspace;

async function put(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true });
  await writeFile(join(root, rel), content);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bw-ws-'));
  root = join(base, 'project');
  await mkdir(root);
  await put('.gitignore', '.env\nsecret/\n*.key\nbuild/\n');
  await put('.env', 'TOKEN=hunter2');
  await put('secret/plan.txt', 'hidden');
  await put('src/app.js', 'const a = 1;\nconst b = 2;\n');
  await put('src/.gitignore', '!local.key\n');
  await put('src/local.key', 'not really secret');
  await put('.git/config', '[remote "origin"]\n\turl = https://token@github.com/x.git\n');
  await put('../outside.txt', 'the operator\'s other files');
  ws = await Workspace.open(root);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('paths', () => {
  it('refuses absolute paths and paths that climb out', async () => {
    await expect(ws.read('/etc/passwd', 1, 10)).rejects.toThrow(/relative/);
    await expect(ws.read('../outside.txt', 1, 10)).rejects.toThrow(/leaves the project/);
    await expect(ws.read('src/../../outside.txt', 1, 10)).rejects.toThrow(/leaves the project/);
  });

  it('does not follow a symlink out of the project', async () => {
    await symlink(join(base, 'outside.txt'), join(root, 'escape.txt'));
    await expect(ws.read('escape.txt', 1, 10)).rejects.toThrow(/does not exist/);
    await expect(ws.write('escape.txt', 'x')).rejects.toThrow(/leaves the project/);
    expect(await readFile(join(base, 'outside.txt'), 'utf8')).toBe('the operator\'s other files');
  });

  it('does not write through a symlinked directory that leads out', async () => {
    await symlink(base, join(root, 'up'));
    await expect(ws.write('up/new.txt', 'x')).rejects.toThrow(/leaves the project/);
    expect(await readdir(base)).not.toContain('new.txt');
  });

  it('does not read an ignored file through an innocent symlink', async () => {
    await symlink(join(root, '.env'), join(root, 'env.txt'));
    await expect(ws.read('env.txt', 1, 10)).rejects.toThrow(/does not exist/);
  });
});

describe('ignored paths do not exist', () => {
  it('answers an ignored file exactly like a missing one', async () => {
    const hidden = await ws.read('.env', 1, 10).catch((e: Error) => e.message);
    const missing = await ws.read('nope.env', 1, 10).catch((e: Error) => e.message);
    expect(hidden).toBe('".env" does not exist');
    expect(missing).toBe('"nope.env" does not exist');
  });

  it('hides everything under an ignored directory, even what a nested rule re-includes', async () => {
    await put('secret/.gitignore', '!plan.txt\n');
    await expect(ws.read('secret/plan.txt', 1, 10)).rejects.toThrow(/does not exist/);
  });

  it('hides .git, which holds hooks and remote URLs with tokens', async () => {
    await expect(ws.read('.git/config', 1, 10)).rejects.toThrow(/does not exist/);
    await expect(ws.write('.git/hooks/pre-commit', '#!/bin/sh\ncurl evil')).rejects.toThrow(/cannot be written/);
  });

  it('lets a nested .gitignore re-include a file, as git does', async () => {
    expect((await ws.read('src/local.key', 1, 10)).text).toBe('not really secret');
  });

  it('cannot move an ignored file to a visible name', async () => {
    await expect(ws.move('.env', 'env.txt')).rejects.toThrow(/cannot be written/);
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('TOKEN=hunter2');
  });

  it('cannot change the ignore rules, at any depth', async () => {
    await expect(ws.write('.gitignore', '')).rejects.toThrow(/is an ignore file.*ignore:add/);
    await expect(ws.write('src/.gitignore', '!*')).rejects.toThrow(/is an ignore file.*ignore:add/);
    await expect(ws.write('lib/.bushwhackignore', '')).rejects.toThrow(/is an ignore file.*ignore:add/);
  });

  it('cannot write into an ignored directory', async () => {
    await expect(ws.write('build/out.js', 'x')).rejects.toThrow(/cannot be written/);
  });

  it('leaves ignored entries out of a listing and out of a search', async () => {
    const listed = await ws.list('.', 3);
    expect(listed.text).toContain('app.js');
    expect(listed.text).not.toMatch(/\.env|secret|\.git\//);
    expect(listed.hidden).toBeGreaterThanOrEqual(3);

    await put('src/uses.js', 'hunter2 is mentioned here');
    const found = await ws.search('hunter2', '.', false);
    expect(found.text).toBe('src/uses.js:1: hunter2 is mentioned here');
  });
});

describe('reading', () => {
  it('reads a range and says what it gave', async () => {
    const r = await ws.read('src/app.js', 2, 5);
    expect(r).toEqual({ text: 'const b = 2;', range: '2-2 of 2', truncated: false });
  });

  it('refuses a binary file', async () => {
    await writeFile(join(root, 'img.png'), Buffer.from([0x89, 0x50, 0, 0, 1]));
    await expect(ws.read('img.png', 1, 10)).rejects.toThrow(/binary/);
  });
});

describe('writing', () => {
  it('creates a file and its directories', async () => {
    expect(await ws.write('lib/deep/new.js', 'x')).toEqual({ rel: 'lib/deep/new.js', created: true, bytes: 1 });
    expect(await readFile(join(root, 'lib/deep/new.js'), 'utf8')).toBe('x');
  });

  it('applies SEARCH/REPLACE edits all or nothing', async () => {
    const good = parseEdits('<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 10;\n>>>>>>> REPLACE');
    await ws.edit('src/app.js', good);
    expect(await readFile(join(root, 'src/app.js'), 'utf8')).toBe('const a = 10;\nconst b = 2;\n');

    const partlyBad = [...good.map(() => ({ search: 'const b = 2;', replace: 'B' })), { search: 'nowhere', replace: 'x' }];
    await expect(ws.edit('src/app.js', partlyBad)).rejects.toThrow(/found 0 times/);
    expect(await readFile(join(root, 'src/app.js'), 'utf8')).toBe('const a = 10;\nconst b = 2;\n');
  });

  it('refuses an ambiguous SEARCH', async () => {
    await put('dup.txt', 'x\nx\n');
    await expect(ws.edit('dup.txt', [{ search: 'x', replace: 'y' }])).rejects.toThrow(/found 2 times/);
  });

  it('keeps $ patterns in a replacement literal', async () => {
    await ws.edit('src/app.js', [{ search: 'const a = 1;', replace: "const a = '$&';" }]);
    expect(await readFile(join(root, 'src/app.js'), 'utf8')).toContain("const a = '$&';");
  });

  it('will not delete a directory holding files it cannot see', async () => {
    await put('conf/.gitignore', '');
    await expect(ws.delete('secret')).rejects.toThrow(/cannot be written/);
    await expect(ws.delete('conf')).rejects.toThrow('"conf" is not empty');
  });
});

describe('runFsTool', () => {
  it('ends a written file with a newline, which the call grammar cannot express', async () => {
    await runFsTool(ws, 'fs:write', { path: 'n.txt' }, 'last line');
    await runFsTool(ws, 'fs:write', { path: 'empty.txt' }, '');
    expect(await readFile(join(root, 'n.txt'), 'utf8')).toBe('last line\n');
    expect(await readFile(join(root, 'empty.txt'), 'utf8')).toBe('');
  });

  it('turns a refusal into a result the model reads', async () => {
    expect(await runFsTool(ws, 'fs:read', { path: '.env', from: 1, lines: 10 }, null)).toEqual({
      status: 'error',
      content: '".env" does not exist',
    });
  });
});
