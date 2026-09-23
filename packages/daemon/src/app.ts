/**
 * The app:* tools: the session's web app, run through octopod.
 *
 * What the app is comes from an octopod recipe (`node-app`…): its image, its user named
 * after the project at the operator's uid, the project mounted at /app, its port and
 * profile. bushwhack adds what a web chat's app needs on top, as a compose file of its
 * own over the recipe: `.bushwhack/` hidden, `.git/` read-only, capabilities dropped, an
 * internal network, and a way out only when the operator approves it. Both files are
 * written where the model cannot see them: `.bushwhack/app/`. octopod renders the recipe,
 * routes the app at `http://<session>.localhost`, keeps its data in the project.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Args, Result, ToolSpec } from '@bushwhack/protocol';
import type { ToolRun } from './dispatcher.js';
import type { OctopodClient, OctopodPlan, OctopodStatus } from './octopod-client.js';
import type { SessionInfo } from './session.js';

/** The one service name of a session's app. */
const SERVICE = 'app';
/** The app's database, when it has one: the host its URL names. */
const DATABASE = 'db';
/** Database recipes an app can have beside it: each provides `sql`, which an app recipe takes as DATABASE_URL. */
const DATABASES = ['postgres', 'mariadb'];

/** The recipes that are web apps a session can create: `<toolchain>-app`. */
export function stacksOf(recipes: { id: string }[]): string[] {
  return recipes.map((r) => r.id).filter((id) => id.endsWith('-app')).sort();
}

/** The databases octopod has a recipe for. */
export function databasesOf(recipes: { id: string }[]): string[] {
  return recipes.map((r) => r.id).filter((id) => DATABASES.includes(id)).sort();
}

export function appTools(stacks: string[], databases: string[] = []): ToolSpec[] {
  return [
    {
      name: 'app:create',
      summary:
        'Create and start the project’s web app from a stack. It serves the project folder (mounted at /app) at http://<project>.localhost. One app per project.',
      approval: true,
      params: {
        stack: { type: 'enum', description: 'the toolchain: ' + stacks.join(', '), values: stacks, ...(stacks.length === 1 ? { default: stacks[0] } : {}) },
        internet: { type: 'bool', description: 'let the app reach the internet (npm install needs it)', default: false },
        ...(databases.length > 0
          ? { database: { type: 'enum', description: 'a database beside the app; its URL is DATABASE_URL in the app', values: ['none', ...databases], default: 'none' } }
          : {}),
      },
      ...(databases.length > 0
        ? {
            notes: [
              'With a database, the app finds it in DATABASE_URL (the database answers at host `db`); its data is kept with the app, out of the project files. app:destroy removes it with the app.',
              'To add a database to an app that exists: app:destroy, then app:create with it.',
            ],
          }
        : {}),
    },
    { name: 'app:status', summary: 'Whether the app runs, and its URL.', approval: false, params: {} },
    {
      name: 'app:logs',
      summary: 'The last lines of the app’s output.',
      approval: false,
      params: { lines: { type: 'int', description: 'how many lines', min: 1, max: 500, default: 100 } },
    },
    {
      name: 'app:restart',
      summary:
        'Restart the app. Its dev script runs as the project says: if it watches the files (node --watch, nodemon, vite…), code changes apply by themselves. Restart after what it does not watch — dependencies installed, environment changed — or when it stopped.',
      approval: true,
      params: {},
    },
    {
      name: 'app:env',
      summary: 'The environment variables the app runs with (PORT, HOST, DATABASE_URL…): names and values, passwords and keys masked.',
      approval: false,
      params: {},
    },
    {
      name: 'app:exec',
      summary: 'Run a command inside the app (sh -lc, in /app): npm install, tests, a build. Output is bounded.',
      approval: true,
      params: {
        command: { type: 'text', description: 'the command line', required: true, maxLength: 500 },
        timeout: { type: 'int', description: 'seconds before it is stopped', min: 1, max: 600, default: 120 },
      },
      notes: [
        'A command is one line of at most 500 characters. To read the project\'s files use fs:read and fs:list, to write them fs:write and fs:edit — not the app: they need no container, and I see their diff.',
        'A file is never written through app:exec — no echo or printf into it, no base64 -d, no here-document, no tee: such a command is refused. fs:write takes a whole file of any length as its body.',
        'Keep the output to what tells you the outcome: quiet flags help (npm install --no-fund --no-audit --loglevel=error; a test runner\'s own quiet or dot reporter). The exit status says whether it passed.',
        'No command waits for input: there is none. Pass flags that answer (npm init -y, --yes).',
      ],
    },
    { name: 'app:destroy', summary: 'Stop and remove the app, its containers and volumes. The project files stay.', approval: true, params: {} },
  ];
}

type Outcome = Omit<Result, 'tool' | 'id'>;

export class AppHost {
  constructor(
    private readonly session: SessionInfo,
    private readonly octopod: OctopodClient,
    private readonly databases: string[] = [],
  ) {}

  private get dir(): string {
    return join(this.session.stateDir, 'app');
  }

  /**
   * The app's credentials — its database password, any key or token its environment
   * holds — masked in everything the chat gets: an `app:exec env`, a log printing its
   * configuration, a connection error. Read once, again after app:create and
   * app:restart, forgotten with app:destroy.
   */
  private credentials: string[] | undefined;

  private async readCredentials(): Promise<void> {
    if (!(await this.exists())) {
      this.credentials = [];
      return;
    }
    const env = await this.octopod.exec(this.session.name, SERVICE, ['env'], 15_000).catch(() => undefined);
    // What octopod generated, it knows for sure; the environment's names only hint at the
    // rest (a key the project brings itself).
    const generated = await Promise.resolve(this.octopod.secrets?.(this.session.name) ?? []).catch((e: Error) => {
      console.warn(`octopod secrets ${this.session.name}: ${e.message} — masking by variable names only`);
      return [];
    });
    this.credentials = [...new Set([...generated.filter((v) => v.length >= MIN_CREDENTIAL), ...(env?.ok ? credentialsOf(env.output) : [])])];
  }

  /** Masks the app's credentials in a text. */
  async mask(): Promise<(text: string) => string> {
    if (this.credentials === undefined) await this.readCredentials();
    // The longest first: a value inside another does not leave the rest of that one showing.
    const values = [...(this.credentials ?? [])].sort((a, b) => b.length - a.length);
    return (text) => values.reduce((masked, value) => masked.split(value).join('‹hidden›'), text);
  }

  private async exists(): Promise<boolean> {
    return stat(join(this.dir, 'octopod.yaml')).then(() => true, () => false);
  }

  /**
   * The declaration: the recipe, the project's folder as its workspace, bushwhack's layer —
   * and the database recipe beside it, if any: octopod gives its URL to the app, which
   * requires `sql`.
   */
  private declaration(stack: string, database: string | undefined): Record<string, unknown> {
    return {
      project: this.session.name,
      services: { [SERVICE]: { recipe: stack }, ...(database ? { [DATABASE]: { recipe: database } } : {}) },
      workspace: this.session.folder,
      compose: ['policy.json'],
    };
  }

  /** The database asked for, checked against the recipes octopod has. */
  private database(args: Args): string | undefined {
    const asked = args.database === undefined || args.database === 'none' ? undefined : String(args.database);
    if (asked && !this.databases.includes(asked)) throw new Error(`no database "${asked}": ${['none', ...this.databases].join(', ')}`);
    return asked;
  }

  /**
   * bushwhack's layer over the recipe. Compose merges it into the recipe's service: the
   * mounts add to the workspace's (by target), the networks replace the implicit default —
   * so the app reaches nothing but its project, unless egress was approved.
   */
  private async policy(workspace: string, internet: boolean, database: boolean): Promise<Record<string, unknown>> {
    const git = await stat(join(this.session.folder, '.git')).then(() => true, () => false);
    return {
      services: {
        [SERVICE]: {
          cap_drop: ['ALL'],
          security_opt: ['no-new-privileges:true'],
          volumes: [
            // The session's state is in the project; the app must not see it.
            { type: 'tmpfs', target: `${workspace}/.bushwhack`, read_only: true, tmpfs: { size: 4096 } },
            // A container that could write a hook would run code on the host at the next commit.
            ...(git ? [`${join(this.session.folder, '.git')}:${workspace}/.git:ro`] : []),
          ],
          networks: internet ? ['internal', 'egress'] : ['internal'],
        },
        // The database on the app's own network, and no other: reachable by the app, and
        // by nothing, nowhere, else.
        ...(database ? { [DATABASE]: { networks: ['internal'] } } : {}),
      },
      networks: { internal: { internal: true }, ...(internet ? { egress: {} } : {}) },
    };
  }

  /** Write both files into `dir` and ask octopod what they make. */
  private async prepare(dir: string, stack: string, internet: boolean, database: string | undefined): Promise<OctopodPlan> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'octopod.yaml'), JSON.stringify(this.declaration(stack, database), null, 2) + '\n');
    // The plan renders the recipe alone: the policy file is not read for it.
    const plan = await this.octopod.plan(dir);
    const workspace = plan.services.find((s) => s.name === SERVICE)?.workspace;
    if (!workspace) throw new Error(`recipe '${stack}' does not work on the project's files`);
    await writeFile(join(dir, 'policy.json'), JSON.stringify(await this.policy(workspace, internet, database !== undefined), null, 2) + '\n');
    return plan;
  }

  /** The approval text for app:create: octopod's plan, and what bushwhack adds to it. */
  async preview(args: Args): Promise<string> {
    const internet = args.internet === true;
    // A draft beside the real one: `.bushwhack/app/` existing means the app exists.
    const draft = join(this.session.stateDir, 'app-draft');
    try {
      const database = this.database(args);
      const plan = await this.prepare(draft, String(args.stack), internet, database);
      return [
        plan.text,
        `    network ${internet ? 'EGRESS — can reach the internet' : 'internal only'}`,
        ...(database ? [`    database ${database}, reachable by the app only (DATABASE_URL)`] : []),
        '    hidden  .bushwhack/ (empty, read-only); .git/ read-only; all capabilities dropped',
        `    served  http://${this.session.name}.localhost (through octopod)`,
      ].join('\n');
    } finally {
      await rm(draft, { recursive: true, force: true });
    }
  }

  /**
   * The app a few seconds after it was (re)started: docker says "running" at once, even of
   * an app that dies at start and restarts in a loop. Any look in that time that does not
   * see it running tells the model why, instead of "running".
   */
  private async settled(name: string, started: OctopodStatus): Promise<Outcome> {
    let status = started;
    for (let waited = 0; waited < APP_SETTLE.ms; waited += APP_SETTLE.every) {
      if (this.describe(status).meta?.state !== 'running') break;
      await new Promise((r) => setTimeout(r, APP_SETTLE.every));
      status = await this.octopod.status(name);
    }
    const outcome = this.describe(status);
    return outcome.meta?.state === 'running' ? outcome : { ...(await this.failing(name, outcome)), status: 'error' };
  }

  /** An app not running: its state, its last lines, and what still works. */
  private async failing(name: string, status: Outcome): Promise<Outcome> {
    const lines = await this.octopod.logs(name, SERVICE, 15).catch(() => []);
    return {
      ...status,
      content: [
        status.meta?.state === 'restarting' ? 'the app is restarting in a loop: it fails at start. Its last lines:' : `the app is ${String(status.meta?.state)}. Its last lines:`,
        ...lines.map((l) => `  ${l}`),
        'app:exec still works (in a one-off container of the app): install dependencies, fix what fails, then app:restart.',
      ].join('\n'),
    };
  }

  private describe(status: OctopodStatus): Outcome {
    const app = status.services.find((s) => s.service === SERVICE);
    const url = status.routes.find((r) => r.service === SERVICE)?.url ?? '';
    return {
      status: 'ok',
      meta: { state: app?.state ?? 'absent', ...(app?.health ? { health: app.health } : {}), url },
      content: app?.state === 'running' ? `running at ${url}` : `the app is ${app?.state ?? 'not running'} — app:logs says why`,
    };
  }

  /** Whether the app was created with internet access. */
  private async online(): Promise<boolean> {
    try {
      const policy = JSON.parse(await readFile(join(this.dir, 'policy.json'), 'utf8')) as { networks?: Record<string, unknown> };
      return 'egress' in (policy.networks ?? {});
    } catch {
      return false;
    }
  }

  /** The URLs the app is served at; none when there is no app. */
  async urls(): Promise<string[]> {
    if (!(await this.exists())) return [];
    return (await this.octopod.status(this.session.name)).routes.map((r) => r.url);
  }

  async run(call: ToolRun): Promise<Outcome> {
    const name = this.session.name;
    if (call.tool !== 'app:create' && !(await this.exists())) {
      return { status: 'error', content: 'there is no app yet — create one with app:create' };
    }
    switch (call.tool) {
      case 'app:create': {
        // An app whose creation was cut short (the service restarted mid-way) has its
        // files and nothing running: creating it again finishes the job.
        if (await this.exists() && (await this.octopod.status(name).catch(() => undefined))?.services.length) {
          return { status: 'error', content: 'the app already exists — app:status, or app:destroy first' };
        }
        const database = this.database(call.args);
        await this.prepare(this.dir, String(call.args.stack), call.args.internet === true, database);
        await this.octopod.register(this.dir);
        const created = await this.settled(name, await this.octopod.up(name));
        await this.readCredentials();
        return database ? { ...created, content: `${created.content}\nwith a ${database} database: DATABASE_URL in the app, host db` } : created;
      }
      case 'app:status': {
        const status = this.describe(await this.octopod.status(name));
        if (status.meta?.state === 'running' || status.meta?.state === 'absent') return status;
        // Not running — often dying at start, in a loop: say why, and what still works.
        return this.failing(name, status);
      }
      case 'app:logs': {
        const lines = await this.octopod.logs(name, SERVICE, Number(call.args.lines));
        return { status: 'ok', meta: { lines: lines.length }, content: lines.join('\n') };
      }
      case 'app:restart': {
        const restarted = await this.settled(name, await this.octopod.restart(name, SERVICE));
        await this.readCredentials();
        return restarted;
      }
      case 'app:env': {
        const result = await this.octopod.exec(name, SERVICE, ['env'], 15_000);
        if (!result.ok) return { status: 'error', content: result.output };
        const lines = result.output.split('\n').filter((l) => l.includes('=')).map(maskEnv).sort();
        return { status: 'ok', meta: { variables: lines.length }, content: lines.join('\n') };
      }
      case 'app:exec': {
        if (writesAFile(String(call.args.command))) {
          // Not run: a file pieced together through the shell (echo … >>, base64 -d) costs a call
          // per chunk, breaks on quoting, and is written where I see no diff.
          return {
            status: 'error',
            content: 'not run: this command writes a file of the project. Write files with fs:write (the whole file, any length, as the body) or change them with fs:edit — never through app:exec.',
          };
        }
        const result = await this.octopod.exec(name, SERVICE, ['sh', '-lc', String(call.args.command)], Number(call.args.timeout) * 1000);
        const notes = [
          ...(result.mode === 'run' ? ['(the app is not running: this ran in a one-off container of it)'] : []),
          ...(!result.ok && !(await this.online()) ? ['(the app has no internet access — npm install and the like need it: app:destroy, then app:create with internet: true)'] : []),
        ];
        return {
          status: result.ok ? 'ok' : 'error',
          meta: { ...(result.truncated ? { truncated: true } : {}), ...(result.mode ? { mode: result.mode } : {}) },
          content: [...notes, result.output].join('\n'),
        };
      }
      case 'app:destroy':
        await this.octopod.unregister(name);
        await rm(this.dir, { recursive: true, force: true });
        this.credentials = [];
        return { status: 'ok', content: 'the app is gone — with its database, if it had one; the project files are untouched' };
      default:
        return { status: 'error', content: `unknown tool ${call.tool}` };
    }
  }
}

/**
 * Whether a command writes a file's contents itself: text echoed or decoded into it, a
 * here-document, tee. Redirections to /dev/… and between streams (2>&1) do not count; a
 * program writing its own files (npm install, a build) does not either.
 */
export function writesAFile(command: string): boolean {
  if (/\bbase64\s+(-d|--decode)\b/.test(command)) return true;
  if (/<<-?\s*['"]?\w+/.test(command) || /\btee\b/.test(command)) return true;
  return /\b(echo|printf|cat)\b[^;&|]*(\|[^;&]*)?(^|[^0-9&])>>?\s*(?!\/dev\/|&)\S/.test(command);
}

/** How long an app is watched after a start, and how often: a start that fails shows within it. */
export const APP_SETTLE = { ms: 6000, every: 1000 };

/** Names that say their value is a credential. */
const SECRET_NAME = /PASS|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE/i;

/**
 * One `NAME=value` line of the app's environment, as the chat may see it: a credential
 * masked — the whole value when the name says so, a URL's password otherwise.
 */
export function maskEnv(line: string): string {
  const at = line.indexOf('=');
  const name = line.slice(0, at);
  const value = line.slice(at + 1);
  if (SECRET_NAME.test(name)) return `${name}=‹hidden›`;
  return `${name}=${value.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+):[^@\s]+@/i, '$1:‹hidden›@')}`;
}

/** Shorter values are not masked: a short word would be masked everywhere it appears. */
const MIN_CREDENTIAL = 6;

/**
 * The credentials in an app's environment (`env` output): the value of any variable whose
 * name says it is one, and the password of any URL.
 */
export function credentialsOf(env: string): string[] {
  const found = new Set<string>();
  for (const line of env.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const name = line.slice(0, at);
    const value = line.slice(at + 1).trim();
    if (SECRET_NAME.test(name)) found.add(value);
    const password = /^[a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:([^@\s]+)@/i.exec(value)?.[1];
    if (password) found.add(password);
  }
  return [...found].filter((v) => v.length >= MIN_CREDENTIAL);
}
