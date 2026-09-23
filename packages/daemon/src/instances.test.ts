/**
 * Instances: a default service and others beside it (`dev`…), each with its own state,
 * code and port — and a folder active in one instance at a time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OctopodClient } from './octopod-client.js';
import { instanceDir, listInstances, startService, type Service } from './service.js';
import { unitFile, unitName } from './service-client.js';

const noOctopod = { available: async () => false } as unknown as OctopodClient;
let base: string;
let env: NodeJS.ProcessEnv;
let running: Service[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bw-instances-'));
  env = { XDG_STATE_HOME: join(base, 'state') };
  running = [];
});

afterEach(async () => {
  for (const s of running) await s.close();
  await rm(base, { recursive: true, force: true });
});

async function start(instance: string, ports: number[]): Promise<Service> {
  const service = await startService({ instance, env, ports, octopod: noOctopod, out: () => {} });
  running.push(service);
  return service;
}

describe('instances', () => {
  it('run side by side, each with its own state, code and port, and are listed', async () => {
    const standard = await start('default', [19590, 19591]);
    const dev = await start('dev', [19590, 19591, 19592]);
    expect(dev.port).not.toBe(standard.port);
    expect(dev.code).not.toBe(standard.code);
    expect(instanceDir('dev', env)).toBe(join(base, 'state', 'bushwhack', 'service-dev'));
    const listed = await listInstances(env);
    expect(listed.map((i) => [i.name, i.file?.port])).toEqual([
      ['default', standard.port],
      ['dev', dev.port],
    ]);
  });

  it('keep a folder active in one instance only, and let it go when that one removes it', async () => {
    const folder = join(base, 'shop');
    await mkdir(folder);
    const standard = await start('default', [19593, 19594]);
    const dev = await start('dev', [19593, 19594, 19595]);
    await standard.add(folder);
    await expect(dev.add(folder)).rejects.toThrow(/active in the "default" instance/);
    await standard.remove(folder);
    expect((await dev.add(folder)).folder).toBe(folder);
    expect((await listInstances(env)).find((i) => i.name === 'dev')?.projects).toEqual([folder]);
  });

  it('refuses a name that is not one', () => {
    expect(() => instanceDir('Dev Env', env)).toThrow(/not an instance name/);
  });

  it('runs the others as instances of a systemd template', () => {
    expect(unitName('default')).toBe('bushwhack.service');
    expect(unitName('dev')).toBe('bushwhack@dev.service');
    expect(unitFile('/opt/bw/bin/bushwhack', { PATH: '/usr/bin' }, 'dev')).toContain('ExecStart=/opt/bw/bin/bushwhack daemon --instance %i');
  });
});
