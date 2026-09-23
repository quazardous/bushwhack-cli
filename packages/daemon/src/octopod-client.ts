/**
 * octopod, from bushwhack's side: its CLI with `--json`. octopod is a separate project —
 * the edge and the composition of Docker projects behind it — and bushwhack only uses its
 * published operations; nothing here depends on its code.
 *
 * The binary is `octopod` on the PATH, or whatever BUSHWHACK_OCTOPOD names.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export interface OctopodRoute {
  service: string;
  url: string;
}

export interface OctopodStatus {
  name: string;
  root: string;
  routes: OctopodRoute[];
  services: { service: string; state: string; health?: string }[];
}

export interface OctopodExec {
  ok: boolean;
  /** `run`: the app was not running, so the command ran in a one-off container of it. */
  mode?: 'exec' | 'run';
  output: string;
  truncated: boolean;
}

/** What octopod's plan says of a service made of a recipe. */
export interface OctopodPlannedService {
  name: string;
  recipe: string;
  digest: string;
  workspace?: string;
  port?: number;
}

export interface OctopodPlan {
  project: string;
  /** One screen, for the approval. */
  text: string;
  services: OctopodPlannedService[];
}

export interface OctopodRecipe {
  id: string;
  title: string;
  summary: string;
  digest: string;
}

/** The octopod contract this bushwhack speaks: `octopod version` must say the same. */
export const OCTOPOD_CONTRACT = 1;

/** `features`: what this octopod has beyond its contract (`secrets`, …) — absent before 0.2. */
export type OctopodCheck = { ok: true; version: string; features?: string[] } | { ok: false; why: string };

export interface OctopodClient {
  /** Whether octopod answers at all (installed, the right contract, docker reachable). */
  available(): Promise<boolean>;
  /** The same, saying why not — what the operator reads next to the project. */
  check?(): Promise<OctopodCheck>;
  register(root: string): Promise<{ name: string; routes: OctopodRoute[] }>;
  /** What `up` would run for a folder's octopod.yaml; writes nothing. */
  plan(root: string): Promise<OctopodPlan>;
  /** The recipes a project can name. */
  recipes(): Promise<OctopodRecipe[]>;
  up(name: string): Promise<OctopodStatus>;
  status(name: string): Promise<OctopodStatus>;
  restart(name: string, service: string): Promise<OctopodStatus>;
  exec(name: string, service: string, argv: string[], timeoutMs: number): Promise<OctopodExec>;
  logs(name: string, service: string, tail: number): Promise<string[]>;
  /**
   * The secret values octopod generated for a project's services (a database password…),
   * for masking: `[]` from an octopod without the `secrets` feature.
   */
  secrets?(name: string): Promise<string[]>;
  unregister(name: string): Promise<void>;
}

export class OctopodError extends Error {
  /** `ENOENT`: no octopod binary at all. */
  code?: string;
}

/**
 * What to start for `binary`: a script is run by this node. On Windows the command on the
 * PATH is a `.cmd` shim, which only a shell runs — and a shell would re-read the arguments:
 * the script the shim starts is run instead, read from npm's shim or from octopod's own
 * (`rem entry <script>`).
 */
export function octopodCommand(binary: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (/\.m?js$/i.test(binary)) return [process.execPath, [binary]];
  if (platform !== 'win32' || /\.exe$/i.test(binary)) return [binary, []];
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  const shims = /\.cmd$/i.test(binary) ? [binary] : isAbsolute(binary) ? [`${binary}.cmd`] : pathVar.split(delimiter).filter(Boolean).map((d) => join(d, `${binary}.cmd`));
  for (const shim of shims) {
    let text: string;
    try {
      text = readFileSync(shim, 'utf8');
    } catch {
      continue;
    }
    const own = /^rem entry (.+\.m?js)\s*$/im.exec(text)?.[1];
    if (own) return [process.execPath, [own.trim()]];
    const npm = /"%(?:~)?dp0%?\\([^"]+\.m?js)"/i.exec(text)?.[1];
    if (npm) return [process.execPath, [join(dirname(shim), npm)]];
  }
  return [binary, []];
}

export function octopodCli(binary = process.env.BUSHWHACK_OCTOPOD || 'octopod', env: NodeJS.ProcessEnv = process.env): OctopodClient {
  const run = (args: string[], timeoutMs = 5 * 60_000): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const [command, before] = octopodCommand(binary, env);
      execFile(command, [...before, ...args, '--json'], { env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          const failed = new OctopodError((stderr || error.message).trim().replace(/^octopod: /, ''));
          if (typeof (error as NodeJS.ErrnoException).code === 'string') failed.code = (error as NodeJS.ErrnoException).code;
          reject(failed);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new OctopodError(`octopod answered something that is not JSON: ${stdout.slice(0, 200)}`));
        }
      });
    });

  /** The features the last check found: an octopod updated meanwhile is seen at the next one. */
  let features: string[] | undefined;
  const check = async (): Promise<OctopodCheck> => {
    let said: { version?: unknown; contract?: unknown; features?: unknown };
    try {
      said = (await run(['version'], 15_000)) as typeof said;
    } catch (e) {
      const error = e as OctopodError;
      if (error.code === 'ENOENT') return { ok: false, why: 'octopod is not installed (see the quickstart), nor BUSHWHACK_OCTOPOD set' };
      // An octopod too old to know `version` says so; one that does not start at all (a
      // broken install) must not be taken for an old one.
      return /unknown command|unknown option|usage:/i.test(error.message)
        ? { ok: false, why: 'octopod is older than 0.1 (it has no `octopod version`): update it — npm i -g @quazardous/octopod' }
        : { ok: false, why: `octopod does not start: ${error.message.split('\n').find((l) => /Error/.test(l))?.trim() ?? error.message.split('\n')[0]} — reinstall it (npm i -g @quazardous/octopod)` };
    }
    const version = String(said.version ?? '?');
    features = Array.isArray(said.features) ? said.features.filter((f): f is string => typeof f === 'string') : [];
    if (said.contract !== OCTOPOD_CONTRACT) {
      const older = typeof said.contract === 'number' && said.contract < OCTOPOD_CONTRACT;
      return { ok: false, why: `octopod ${version} speaks contract ${String(said.contract)}, this bushwhack contract ${OCTOPOD_CONTRACT}: update ${older ? 'octopod (npm i -g @quazardous/octopod)' : 'bushwhack'}` };
    }
    try {
      await run(['edge', 'status'], 15_000);
    } catch {
      return { ok: false, why: `octopod ${version} answers, its edge does not — is docker running? (octopod edge status)` };
    }
    return { ok: true, version, features };
  };

  return {
    async available() {
      return (await check()).ok;
    },
    check,
    register: (root) => run(['register', root]) as Promise<{ name: string; routes: OctopodRoute[] }>,
    plan: (root) => run(['plan', root]) as Promise<OctopodPlan>,
    recipes: async () => ((await run(['recipes'])) as { recipes: OctopodRecipe[] }).recipes,
    up: (name) => run(['up', name], 15 * 60_000) as Promise<OctopodStatus>,
    status: (name) => run(['status', name]) as Promise<OctopodStatus>,
    restart: (name, service) => run(['restart', name, '--service', service]) as Promise<OctopodStatus>,
    exec: (name, service, argv, timeoutMs) =>
      run(['exec', name, service, '--timeout', String(timeoutMs), '--', ...argv], timeoutMs + 30_000) as Promise<OctopodExec>,
    logs: async (name, service, tail) => ((await run(['logs', name, '--service', service, '--tail', String(tail)])) as { lines: string[] }).lines,
    secrets: async (name) => {
      if (features === undefined) await check();
      if (!features?.includes('secrets')) return [];
      return ((await run(['secrets', name])) as { values: string[] }).values;
    },
    unregister: async (name) => {
      await run(['unregister', name]);
    },
  };
}
