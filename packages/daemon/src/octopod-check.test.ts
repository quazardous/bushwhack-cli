/**
 * Which octopod bushwhack works with: the contract `octopod version` states. Checked
 * against small stand-in binaries, one per case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OCTOPOD_CONTRACT, octopodCli } from './octopod-client.js';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bw-octocheck-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** An `octopod` that answers `version` with `version`, and `edge status` with `edge`. */
async function stand(name: string, version: string | null, edge = true, secrets = '{"values":["Zq81xLmw0"]}'): Promise<string> {
  const bin = join(base, name);
  const versionBranch = version === null ? 'echo "octopod: unknown command version" >&2; exit 1' : `echo '${version}'`;
  await writeFile(bin, `#!/bin/sh\ncase "$1" in\n  version) ${versionBranch} ;;\n  edge) ${edge ? 'echo \'{"running":true}\'' : 'echo "docker: not running" >&2; exit 1'} ;;\n  secrets) echo '${secrets}' ;;\n  *) exit 1 ;;\nesac\n`);
  await chmod(bin, 0o755);
  return bin;
}

describe('which octopod bushwhack works with', () => {
  it('takes one that speaks its contract and whose edge answers', async () => {
    const bin = await stand('ok', `{"version":"0.1.0","contract":${OCTOPOD_CONTRACT}}`);
    expect(await octopodCli(bin).check!()).toEqual({ ok: true, version: '0.1.0', features: [] });
    expect(await octopodCli(bin).available()).toBe(true);
  });

  it('says what to do otherwise: install it, update it, update bushwhack, start docker', async () => {
    const why = async (bin: string): Promise<string> => {
      const checked = await octopodCli(bin).check!();
      return checked.ok ? 'ok' : checked.why;
    };
    expect(await why(join(base, 'nowhere'))).toMatch(/not installed/);
    expect(await why(await stand('old', null))).toMatch(/older than 0\.1.*update it/);
    // Installed but broken — its build missing: not an old octopod.
    const broken = join(base, 'broken');
    await writeFile(broken, `#!/bin/sh\necho "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/dist/cli.js'" >&2\nexit 1\n`);
    await chmod(broken, 0o755);
    expect(await why(broken)).toMatch(/does not start: Error \[ERR_MODULE_NOT_FOUND\].*reinstall/);
    expect(await why(await stand('behind', `{"version":"0.0.9","contract":${OCTOPOD_CONTRACT - 1}}`))).toMatch(/update octopod/);
    expect(await why(await stand('ahead', `{"version":"2.0.0","contract":${OCTOPOD_CONTRACT + 1}}`))).toMatch(/update bushwhack/);
    expect(await why(await stand('nodocker', `{"version":"0.1.0","contract":${OCTOPOD_CONTRACT}}`, false))).toMatch(/is docker running/);
  });

  it('asks for the secrets only an octopod with the feature gives', async () => {
    const withSecrets = await stand('new', `{"version":"0.2.0","contract":${OCTOPOD_CONTRACT},"features":["secrets"]}`);
    expect(await octopodCli(withSecrets).secrets!('demo')).toEqual(['Zq81xLmw0']);
    const without = await stand('plain', `{"version":"0.1.1","contract":${OCTOPOD_CONTRACT}}`);
    expect(await octopodCli(without).secrets!('demo')).toEqual([]);
  });
});
