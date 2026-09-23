/**
 * Standalone mode's site: a project's files served as they are, by Host, and nothing the
 * chat could not read with fs:read — no .git/, no .bushwhack/, no ignored file, no declared
 * secret file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@bushwhack/workspace';
import { ProjectSites } from './site.js';

let base: string;
let sites: ProjectSites;

function get(host: string, path: string, method = 'GET'): Promise<{ status: number; type?: string; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: sites.port, path, method, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += String(c)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], location: res.headers.location, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function project(name: string, files: Record<string, string>): Promise<Workspace> {
  const root = join(base, name);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return Workspace.open(root);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bw-site-'));
  sites = await ProjectSites.listen([19600, 19601, 19602]);
  sites.add(
    'demo',
    await project('demo', {
      'index.html': '<h1>demo</h1>',
      'app.js': 'console.log(1)',
      'sql/sql-wasm.wasm': 'wasm',
      'docs/index.html': '<p>docs</p>',
      'empty/.keep': '',
      '.gitignore': 'build/\nnotes.txt\n',
      'notes.txt': 'private',
      'build/out.js': 'x',
      '.git/config': '[core]',
      '.bushwhack/secrets.jsonc': JSON.stringify({ files: { '.env': { format: 'dotenv' } } }),
      '.env': 'TOKEN=hunter2',
    }),
  );
  sites.add('other', await project('other', { 'index.html': '<h1>other</h1>' }));
});

afterEach(async () => {
  await sites.close();
  await rm(base, { recursive: true, force: true });
});

describe("a project's site", () => {
  it('serves its files at <project>.localhost, with their types, fresh every time', async () => {
    const host = `demo.localhost:${sites.port}`;
    expect(sites.urlOf('demo')).toBe(`http://${host}/`);
    expect(await get(host, '/')).toMatchObject({ status: 200, type: 'text/html; charset=utf-8', body: '<h1>demo</h1>' });
    expect(await get(host, '/app.js')).toMatchObject({ status: 200, type: 'text/javascript; charset=utf-8' });
    expect((await get(host, '/sql/sql-wasm.wasm')).type).toBe('application/wasm');
    expect(await get(host, '/docs/')).toMatchObject({ status: 200, body: '<p>docs</p>' });
    expect(await get(host, '/docs')).toMatchObject({ status: 301, location: '/docs/' });
    expect(await get(host, '/empty/')).toMatchObject({ status: 404 });
    expect((await get(`other.localhost:${sites.port}`, '/')).body).toBe('<h1>other</h1>');
  });

  it('serves nothing fs:read would not read, and never a declared secret file', async () => {
    const host = `demo.localhost:${sites.port}`;
    for (const path of ['/.git/config', '/.bushwhack/secrets.jsonc', '/notes.txt', '/build/out.js', '/.env', '/../other/index.html', '/%2e%2e/other/index.html', '/nope.html']) {
      const answer = await get(host, path);
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).not.toMatch(/hunter2|private|core/);
    }
  });

  it('answers only its projects by their own names, and only GET and HEAD', async () => {
    expect((await get(`127.0.0.1:${sites.port}`, '/')).status).toBe(404);
    expect((await get(`evil.example:${sites.port}`, '/')).status).toBe(404);
    expect((await get('demo.localhost:80', '/')).status).toBe(404);
    expect((await get(`gone.localhost:${sites.port}`, '/')).status).toBe(404);
    expect((await get(`demo.localhost:${sites.port}`, '/', 'POST')).status).toBe(405);
    expect(await get(`demo.localhost:${sites.port}`, '/', 'HEAD')).toMatchObject({ status: 200, body: '' });
    sites.remove('demo');
    expect((await get(`demo.localhost:${sites.port}`, '/')).status).toBe(404);
  });
});
