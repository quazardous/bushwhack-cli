import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listReports, markReport, readReports, type Report } from './reports.js';

let base: string;
const report = (id: string, title: string): Report => ({ at: '2026-09-22T15:00:00.000Z', conversation: 'meta.ai/c', id, title, text: 'x', version: '0.1.0', calls: [] });

async function project(name: string, reports: Report[]): Promise<{ name: string; folder: string }> {
  const folder = join(base, name);
  await mkdir(join(folder, '.bushwhack'), { recursive: true });
  for (const r of reports) await appendFile(join(folder, '.bushwhack', 'reports.jsonl'), JSON.stringify(r) + '\n');
  return { name, folder };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bw-reports-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('reports, across projects', () => {
  it('lists every project\'s reports, numbered in their project, new until marked', async () => {
    const shop = await project('shop', [report('b1', 'one'), report('b2', 'two')]);
    const blog = await project('blog', [report('b1', 'three')]);
    const none = { name: 'gone', folder: join(base, 'gone') };
    const listed = await listReports([shop, blog, none]);
    expect(listed.map((r) => [r.project, r.n, r.title, r.state])).toEqual([
      ['shop', 1, 'one', 'new'],
      ['shop', 2, 'two', 'new'],
      ['blog', 1, 'three', 'new'],
    ]);
  });

  it('keeps what became of a report beside it, and never rewrites the reports', async () => {
    const shop = await project('shop', [report('b1', 'one'), report('b2', 'two')]);
    const before = await readFile(join(shop.folder, '.bushwhack', 'reports.jsonl'), 'utf8');
    const [first, second] = await readReports(join(shop.folder, '.bushwhack'));
    await markReport(join(shop.folder, '.bushwhack'), first, 'taken', 'being fixed');
    await markReport(join(shop.folder, '.bushwhack'), second, 'dismissed');
    const listed = await listReports([shop]);
    expect(listed.map((r) => [r.n, r.state, r.note])).toEqual([
      [1, 'taken', 'being fixed'],
      [2, 'dismissed', undefined],
    ]);
    expect(await readFile(join(shop.folder, '.bushwhack', 'reports.jsonl'), 'utf8')).toBe(before);
    // A new report later keeps its own state: new.
    await appendFile(join(shop.folder, '.bushwhack', 'reports.jsonl'), JSON.stringify(report('b3', 'three')) + '\n');
    expect((await listReports([shop])).map((r) => r.state)).toEqual(['taken', 'dismissed', 'new']);
  });
});
