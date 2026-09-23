/**
 * image:save writes a picture the chat generated, picked by its rank among those the
 * extension read off the page — byte-exact, under the name of its real type.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@bushwhack/workspace';
import { decodePicture, runImageTool } from './images.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBP = Buffer.from('RIFF0000WEBPVP8 ');
const url = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString('base64')}`;

let root: string;
let ws: Workspace;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bw-images-'));
  ws = await Workspace.open(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const save = (pictures: { dataUrl: string; width?: number; height?: number }[], args: Record<string, unknown>) =>
  runImageTool(ws, pictures, { tool: 'image:save', args: args as never, body: null });

describe('image:save', () => {
  it('writes the latest picture byte-exact, and an older one by its rank', async () => {
    const pictures = [{ dataUrl: url('image/webp', WEBP), width: 1600, height: 1600 }, { dataUrl: url('image/png', PNG) }];
    const latest = await save(pictures, { path: 'public/logo.webp', image: 1 });
    expect(latest).toMatchObject({ status: 'ok', meta: { path: 'public/logo.webp', type: 'image/webp', created: true } });
    expect(latest.content).toContain('1600×1600');
    expect(await readFile(join(root, 'public/logo.webp'))).toEqual(WEBP);
    expect((await save(pictures, { path: 'old.png', image: 2 })).status).toBe('ok');
    expect(await readFile(join(root, 'old.png'))).toEqual(PNG);
  });

  it('says which name a picture needs, rather than mislabel it', async () => {
    const out = await save([{ dataUrl: url('image/webp', WEBP) }], { path: 'logo.png', image: 1 });
    expect(out).toMatchObject({ status: 'error', content: expect.stringMatching(/WEBP: name the file \.webp/) });
  });

  it('says when there is no such picture, or none at all', async () => {
    expect((await save([], { path: 'a.png', image: 1 })).content).toMatch(/generate it in your answer first/);
    expect((await save([{ dataUrl: url('image/png', PNG) }], { path: 'a.png', image: 3 })).content).toMatch(/1 picture.*image 3 is not one/);
  });

  it('never saves another picture in place of one it could not read', async () => {
    const out = await save([{ dataUrl: '' }, { dataUrl: url('image/webp', WEBP) }], { path: 'favicon.png', image: 1 });
    expect(out).toMatchObject({ status: 'error', content: expect.stringMatching(/picture 1 is on the page but could not be read/) });
  });

  it('keeps to the project, like any write', async () => {
    expect((await save([{ dataUrl: url('image/png', PNG) }], { path: '../out.png', image: 1 })).status).toBe('error');
  });

  it('reads only pictures from a data: URL', () => {
    expect(decodePicture(url('image/png', PNG))?.bytes).toEqual(PNG);
    expect(decodePicture(url('text/html', Buffer.from('<b>')))).toBeUndefined();
    expect(decodePicture('https://example.com/a.png')).toBeUndefined();
  });
});
