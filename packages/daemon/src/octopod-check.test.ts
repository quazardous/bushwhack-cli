/**
 * Which octopod bushwhack works with: the contract `octopod version` states. Checked
 * against small stand-in binaries, one per case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OCTOPOD_CONTRACT, octopodCli, octopodCommand } from './octopod-client.js';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bw-octocheck-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A script run by node: what octopod's own entry point is, on every platform. */
async function script(name: string, body: string): Promise<string> {
  const bin = join(base, `${name}.mjs`);
  await writeFile(bin, body);
  return bin;
}

const fail = (message: string): string => `process.stderr.write(${JSON.stringify(message + '\n')}); process.exit(1);`;

/** An `octopod` that answers `version` with `version`, and `edge status` with `edge`. */
async function stand(name: string, version: string | null, edge = true, secrets = '{"values":["Zq81xLmw0"]}'): Promise<string> {
  return script(
    name,
    `switch (process.argv[2]) {
  case 'version': ${version === null ? fail('octopod: unknown command version') : `console.log(${JSON.stringify(version)});`} break;
  case 'edge': ${edge ? `console.log('{"running":true}');` : fail('docker: not running')} break;
  case 'secrets': console.log(${JSON.stringify(secrets)}); break;
  default: process.exit(1);
}
`,
  );
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
    const broken = await script('broken', fail("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/dist/cli.js'"));
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

describe('what starts octopod', () => {
  it('runs a script with node, and a command as it is off Windows', () => {
    expect(octopodCommand('/opt/octopod/bin/octopod.js', {}, 'linux')).toEqual([process.execPath, ['/opt/octopod/bin/octopod.js']]);
    expect(octopodCommand('octopod', { PATH: base }, 'linux')).toEqual(['octopod', []]);
  });

  // Real shims on disk, read with the host's paths: on Windows only.
  it.skipIf(process.platform !== 'win32')('on Windows, runs the script behind a .cmd shim: npm\'s, or octopod\'s own', async () => {
    await writeFile(join(base, 'octopod.cmd'), '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@quazardous\\octopod\\bin\\octopod.js" %*\r\n');
    expect(octopodCommand('octopod', { Path: `${join(base, 'none')};${base}` }, 'win32')).toEqual([process.execPath, [join(base, 'node_modules', '@quazardous', 'octopod', 'bin', 'octopod.js')]]);
    await writeFile(join(base, 'own.cmd'), '@echo off\r\nrem octopod shim for C:\\octopod\r\nrem entry C:\\octopod\\bin\\octopod.js\r\nnode "C:\\octopod\\bin\\octopod.js" %*\r\n');
    expect(octopodCommand(join(base, 'own.cmd'), {}, 'win32')).toEqual([process.execPath, ['C:\\octopod\\bin\\octopod.js']]);
    expect(octopodCommand('octopod', { Path: join(base, 'none') }, 'win32')).toEqual(['octopod', []]);
  });
});
