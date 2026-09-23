/**
 * The first bushwhack command finds the service, or starts it: once, and only when it
 * does not answer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OctopodClient } from './octopod-client.js';
import { startService, type Service } from './service.js';
import { ensureService, operatorClient, unitFile } from './service-client.js';

const noOctopod = { available: async () => false } as unknown as OctopodClient;
let base: string | undefined;
let service: Service | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
  if (base) await rm(base, { recursive: true, force: true });
});

describe('ensureService', () => {
  it('starts the service when it does not answer, and not again when it does', async () => {
    base = await mkdtemp(join(tmpdir(), 'bw-ensure-'));
    const dir = join(base, 'service');
    let starts = 0;
    const start = async (d: string): Promise<string> => {
      starts++;
      service = await startService({ dir: d, ports: [19570, 19571], octopod: noOctopod, out: () => {} });
      return 'a test';
    };
    const first = await ensureService({ dir, start });
    expect(first.started).toBe('a test');
    const again = await ensureService({ dir, start });
    expect(again.started).toBeUndefined();
    expect(starts).toBe(1);

    // And the operator can use it right away.
    const client = await operatorClient(again.file, 'cli:test');
    try {
      expect(((await client.list()) as { projects: unknown[] }).projects).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('says so when the service does not come up', async () => {
    base = await mkdtemp(join(tmpdir(), 'bw-ensure-'));
    await expect(ensureService({ dir: join(base, 'service'), start: async () => 'nothing', waitMs: 300 })).rejects.toThrow(/did not answer after starting it through nothing/);
  });
});

describe('the systemd unit', () => {
  it('runs the daemon with the PATH of the shell that installed it, where octopod and docker are', () => {
    const unit = unitFile('/opt/bw/bin/bushwhack', { PATH: '/home/op/.local/bin:/usr/bin', BUSHWHACK_OCTOPOD: '/opt/octopod' });
    expect(unit).toContain('ExecStart=/opt/bw/bin/bushwhack daemon');
    expect(unit).toContain('Environment=PATH=/home/op/.local/bin:/usr/bin');
    expect(unit).toContain('Environment=BUSHWHACK_OCTOPOD=/opt/octopod');
    expect(unit).toContain('Restart=on-failure');
  });
});
