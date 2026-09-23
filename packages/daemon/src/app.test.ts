/**
 * The app:* tools against a fake octopod: what bushwhack writes, asks and forwards.
 * (The real chain — octopod, docker, the edge — has its own test in app.integration.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectBridge, type BridgeClient } from './bridge-client.js';
import { APP_SETTLE, AppHost, credentialsOf, maskEnv } from './app.js';
import { describeSession } from './session.js';
import type { Approver } from './dispatcher.js';
import type { OctopodClient, OctopodExec, OctopodStatus } from './octopod-client.js';
import { serve, type Serving } from './serve.js';

const PORTS = [19480, 19481];

let base: string;
let folder: string;
let serving: Serving | undefined;
let bridge: BridgeClient | undefined;
let calls: string[];
let asked: string[];

const approver: Approver = {
  async ask(call) {
    asked.push(call.tool);
    return 'yes';
  },
  async secretValue() {
    return undefined;
  },
};

function fakeOctopod(available = true, appState = 'running', exec: OctopodExec = { ok: true, mode: 'exec', output: 'done\n', truncated: false }): OctopodClient {
  const status = (name: string, state = 'running'): OctopodStatus => ({
    name,
    root: '',
    routes: [{ service: 'app', url: `http://${name}.localhost` }],
    services: [{ service: 'app', state }],
  });
  return {
    available: async () => available,
    register: async (root) => {
      calls.push(`register ${root}`);
      return { name: 'demo', routes: [] };
    },
    plan: async (root) => {
      calls.push(`plan ${root}`);
      return { project: 'demo', text: 'project demo\n+ app  node-app@0123456789ab', services: [{ name: 'app', recipe: 'node-app', digest: '0123456789ab', workspace: '/app', port: 3000 }] };
    },
    recipes: async () => [
      { id: 'node-app', title: 'Node', summary: 's', digest: 'd' },
      { id: 'postgres', title: 'PostgreSQL', summary: 's', digest: 'd' },
    ],
    up: async (name) => (calls.push(`up ${name}`), status(name)),
    status: async (name) => status(name, appState),
    restart: async (name, service) => (calls.push(`restart ${name} ${service}`), status(name)),
    exec: async (name, service, argv, timeoutMs) => (calls.push(`exec ${name} ${service} ${JSON.stringify(argv)} ${timeoutMs}`), exec),
    logs: async () => ['line 1', 'line 2'],
    unregister: async (name) => {
      calls.push(`unregister ${name}`);
    },
  };
}

async function start(octopod: OctopodClient): Promise<void> {
  serving = await serve({ folder, approver, ports: PORTS, out: () => {}, env: { XDG_STATE_HOME: join(base, 'state') }, octopod });
  bridge = await connectBridge({ port: serving.port, code: serving.code, daemonNodeId: serving.session.nodeId, nodeId: 'app-test', client: 'test' });
}

const call = (id: string, tool: string, args: Record<string, string> = {}): string =>
  ['---', `bushwhack: ${tool}`, `id: ${id}`, ...Object.entries(args).map(([k, v]) => `${k}: ${v}`), '---end'].join('\n');

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'bw-app-'));
  folder = join(base, 'demo');
  await mkdir(join(folder, '.git'), { recursive: true });
  calls = [];
  asked = [];
});

afterEach(async () => {
  bridge?.close();
  await serving?.close();
  bridge = undefined;
  serving = undefined;
  await rm(base, { recursive: true, force: true });
});

APP_SETTLE.ms = 30;
APP_SETTLE.every = 10;

describe('app tools', () => {
  it('are offered only when octopod answers', async () => {
    await start(fakeOctopod(false));
    expect((await bridge!.list()).tools.some((t) => t.startsWith('app:'))).toBe(false);
    bridge!.close();
    await serving!.close();
    await start(fakeOctopod(true));
    expect((await bridge!.list()).tools).toEqual(expect.arrayContaining(['app:create', 'app:status', 'app:exec', 'app:destroy']));
  });

  it('create: asks, writes the recipe and bushwhack\'s layer out of the project\'s sight, and hands them to octopod', async () => {
    await start(fakeOctopod());
    const reply = await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app' })] }, 5000);
    expect(asked).toEqual(['app:create']);
    expect(reply.text).toContain('running at http://demo.localhost');

    const dir = join(folder, '.bushwhack', 'app');
    // Then its environment is read, for the credentials to mask.
    expect(calls).toEqual([`plan ${dir}`, `register ${dir}`, 'up demo', 'exec demo app ["env"] 15000']);
    // What the app is: octopod's recipe, working on the project's folder.
    expect(JSON.parse(await readFile(join(dir, 'octopod.yaml'), 'utf8'))).toEqual({
      project: 'demo',
      services: { app: { recipe: 'node-app' } },
      workspace: folder,
      compose: ['policy.json'],
    });
    // What a chat's app gets on top: nothing of the session's state, a read-only .git, no
    // capabilities, and no way out.
    const policy = JSON.parse(await readFile(join(dir, 'policy.json'), 'utf8'));
    expect(policy.services.app.volumes).toEqual([
      { type: 'tmpfs', target: '/app/.bushwhack', read_only: true, tmpfs: { size: 4096 } },
      `${folder}/.git:/app/.git:ro`,
    ]);
    expect(policy.services.app.cap_drop).toEqual(['ALL']);
    expect(policy.services.app.security_opt).toEqual(['no-new-privileges:true']);
    expect(policy.services.app.networks).toEqual(['internal']);
    expect(policy.networks).toEqual({ internal: { internal: true } });

    const again = await bridge!.call({ conversation: 'c', calls: [call('a2', 'app:create', { stack: 'node-app' })] }, 5000);
    expect(again.text).toContain('already exists');
  });

  it('create with a database: its recipe beside the app, on the app\'s network only, and said', async () => {
    await start(fakeOctopod());
    expect((await bridge!.list()).manifest).toContain('`database` (none | postgres, default none)');
    const reply = await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app', database: 'postgres' })] }, 5000);
    expect(reply.text).toContain('with a postgres database: DATABASE_URL in the app');
    const dir = join(folder, '.bushwhack', 'app');
    expect(JSON.parse(await readFile(join(dir, 'octopod.yaml'), 'utf8')).services).toEqual({ app: { recipe: 'node-app' }, db: { recipe: 'postgres' } });
    const policy = JSON.parse(await readFile(join(dir, 'policy.json'), 'utf8'));
    expect(policy.services.db).toEqual({ networks: ['internal'] });
    expect(policy.services.app.networks).toEqual(['internal']);
    // The approval shows it.
    const preview = await new AppHost(describeSession(folder), fakeOctopod(), ['postgres']).preview({ stack: 'node-app', database: 'postgres' });
    expect(preview).toContain('database postgres, reachable by the app only');
  });

  it('env shows the app\'s variables, credentials masked', async () => {
    expect(maskEnv('PORT=3000')).toBe('PORT=3000');
    expect(maskEnv('DATABASE_URL=postgresql://app:s3cr3t@db:5432/app')).toBe('DATABASE_URL=postgresql://app:‹hidden›@db:5432/app');
    expect(maskEnv('STRIPE_KEY=sk_live_x')).toBe('STRIPE_KEY=‹hidden›');
    expect(maskEnv('POSTGRES_PASSWORD=x=y')).toBe('POSTGRES_PASSWORD=‹hidden›');
    expect(maskEnv('HOME=/home/demo')).toBe('HOME=/home/demo');
    await start(fakeOctopod(true, 'running', { ok: true, mode: 'exec', output: 'PORT=3000\nDATABASE_URL=postgresql://app:s3cr3t@db:5432/app\n', truncated: false }));
    await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app' })] }, 5000);
    const reply = await bridge!.call({ conversation: 'c', calls: [call('e1', 'app:env')] }, 5000);
    expect(reply.text).toContain('DATABASE_URL=postgresql://app:‹hidden›@db:5432/app\nPORT=3000');
    expect(reply.text).not.toContain('s3cr3t');
  });

  it('create again finishes an app whose creation was cut short, and still refuses a running one', async () => {
    // Its files are there, nothing runs: the service was restarted mid-create.
    const octopod = fakeOctopod();
    let running = false;
    const watching: OctopodClient = {
      ...octopod,
      up: async (name) => ((running = true), octopod.up(name)),
      status: async (name) => ({ name, root: '', routes: [], services: running ? [{ service: 'app', state: 'running' }] : [] }),
    };
    await start(watching);
    await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app' })] }, 5000);
    running = false;
    const resumed = await bridge!.call({ conversation: 'c', calls: [call('a2', 'app:create', { stack: 'node-app' })] }, 5000);
    expect(resumed.summary[0].status).toBe('ok');
    const again = await bridge!.call({ conversation: 'c', calls: [call('a3', 'app:create', { stack: 'node-app' })] }, 5000);
    expect(again.text).toContain('already exists');
  });

  it('finds the credentials in the app\'s environment, and nothing that is not one', () => {
    expect(credentialsOf('PORT=3000\nDATABASE_URL=postgresql://app:s3cr3tPass@db:5432/app\nSTRIPE_KEY=sk_live_abcdef\nAPI_TOKEN=short\nHOME=/home/demo\n')).toEqual(['s3cr3tPass', 'sk_live_abcdef']);
  });

  it('masks the app\'s credentials in every result, however the model asked for them', async () => {
    const env = 'PORT=3000\nDATABASE_URL=postgresql://app:s3cr3tPass@db:5432/app\n';
    const octopod = fakeOctopod(true, 'running', { ok: true, mode: 'exec', output: env, truncated: false });
    await start({ ...octopod, logs: async () => ['connecting to postgresql://app:s3cr3tPass@db:5432/app', 'listening'] });
    await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app' })] }, 5000);
    const exec = await bridge!.call({ conversation: 'c', calls: [call('x1', 'app:exec', { command: 'env' })] }, 5000);
    const logs = await bridge!.call({ conversation: 'c', calls: [call('l1', 'app:logs', { lines: '20' })] }, 5000);
    for (const reply of [exec, logs]) {
      expect(reply.text).not.toContain('s3cr3tPass');
      expect(reply.text).toContain('app:‹hidden›@db:5432');
    }
    expect(exec.text).toContain('PORT=3000');
  });

  it('masks the secrets octopod generated, whatever their variable is called', async () => {
    const env = 'PORT=3000\nDB_CONN=host=db user=app pw=Zq81xLmw0\n';
    const octopod = fakeOctopod(true, 'running', { ok: true, mode: 'exec', output: env, truncated: false });
    await start({ ...octopod, secrets: async (name) => (calls.push(`secrets ${name}`), ['Zq81xLmw0']) });
    await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app' })] }, 5000);
    const exec = await bridge!.call({ conversation: 'c', calls: [call('x1', 'app:exec', { command: 'env' })] }, 5000);
    expect(exec.text).not.toContain('Zq81xLmw0');
    expect(exec.text).toContain('pw=‹hidden›');
    expect(calls).toContain('secrets demo');
  });

  it('an octopod failing to give its secrets leaves the masking by names', async () => {
    const env = 'DATABASE_URL=postgresql://app:s3cr3tPass@db:5432/app\n';
    const octopod = fakeOctopod(true, 'running', { ok: true, mode: 'exec', output: env, truncated: false });
    await start({ ...octopod, secrets: async () => { throw new Error('boom'); } });
    await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app' })] }, 5000);
    const exec = await bridge!.call({ conversation: 'c', calls: [call('x1', 'app:exec', { command: 'env' })] }, 5000);
    expect(exec.text).not.toContain('s3cr3tPass');
  });

  it('create without a database is as before: the app alone', async () => {
    await start(fakeOctopod());
    await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app' })] }, 5000);
    const decl = JSON.parse(await readFile(join(folder, '.bushwhack', 'app', 'octopod.yaml'), 'utf8'));
    expect(Object.keys(decl.services)).toEqual(['app']);
    expect(JSON.parse(await readFile(join(folder, '.bushwhack', 'app', 'policy.json'), 'utf8')).services.db).toBeUndefined();
  });

  it('create with internet access adds egress, and only when asked', async () => {
    await start(fakeOctopod());
    await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app', internet: 'true' })] }, 5000);
    const policy = JSON.parse(await readFile(join(folder, '.bushwhack', 'app', 'policy.json'), 'utf8'));
    expect(policy.services.app.networks).toEqual(['internal', 'egress']);
    expect(Object.keys(policy.networks)).toEqual(['internal', 'egress']);
  });

  it('offers the app recipes octopod has, and only those', async () => {
    await start(fakeOctopod());
    const manifest = (await bridge!.list()).manifest;
    // A stack is an app recipe: postgres is offered as a database, never as a stack.
    const stackLine = manifest.split('\n').find((l) => l.includes('`stack`'))!;
    expect(stackLine).toContain('node-app');
    expect(stackLine).not.toContain('postgres');
  });

  it('exec runs `sh -lc <command>` in the app, as argv, with the timeout in ms', async () => {
    await start(fakeOctopod());
    await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app' })] }, 5000);
    const reply = await bridge!.call({ conversation: 'c', calls: [call('a2', 'app:exec', { command: 'npm test', timeout: '30' })] }, 5000);
    expect(calls).toContain('exec demo app ["sh","-lc","npm test"] 30000');
    expect(reply.text).toContain('done');
  });

  it('status says an app restarting in a loop fails at start, with its last lines, and that exec still works', async () => {
    await start(fakeOctopod(true, 'restarting'));
    await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app' })] }, 5000);
    const reply = await bridge!.call({ conversation: 'c', calls: [call('s1', 'app:status')] }, 5000);
    expect(reply.text).toContain('restarting in a loop');
    expect(reply.text).toContain('  line 2');
    expect(reply.text).toContain('app:exec still works');
  });

  it('exec says when it ran in a one-off container, and that a failure may be the missing internet', async () => {
    await start(fakeOctopod(true, 'restarting', { ok: false, mode: 'run', output: 'npm error\n(timed out after 60 s)', truncated: false }));
    await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app' })] }, 5000);
    const reply = await bridge!.call({ conversation: 'c', calls: [call('a2', 'app:exec', { command: 'npm install' })] }, 5000);
    expect(reply.text).toContain('status: error');
    expect(reply.text).toContain('this ran in a one-off container');
    expect(reply.text).toContain('the app has no internet access');
    expect(reply.text).toContain('(timed out after 60 s)');
  });

  it('refuses everything but create when there is no app', async () => {
    await start(fakeOctopod());
    const reply = await bridge!.call({ conversation: 'c', calls: [call('s1', 'app:status')] }, 5000);
    expect(reply.text).toContain('there is no app yet');
  });

  it('destroy unregisters it and removes its files, leaving the project alone', async () => {
    await start(fakeOctopod());
    await writeFile(join(folder, 'index.js'), 'x');
    await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app' })] }, 5000);
    await bridge!.call({ conversation: 'c', calls: [call('a2', 'app:destroy')] }, 5000);
    expect(calls).toContain('unregister demo');
    await expect(stat(join(folder, '.bushwhack', 'app'))).rejects.toThrow();
    expect(await readFile(join(folder, 'index.js'), 'utf8')).toBe('x');
  });
});

describe('a file written through app:exec', () => {
  it('is recognised, and a program writing its own files is not', async () => {
    const { writesAFile } = await import('./app.js');
    for (const c of [
      "echo 'YXN5bmM=' | base64 -d >> src/public/app.js && echo ok7",
      'printf "%s" "x" > src/a.js',
      "cat > src/a.js <<'EOF'",
      'echo hi | tee src/a.txt',
      'base64 --decode chunk > a.js',
      'rm -f src/public/app.js && echo x>>src/public/app.js',
    ]) expect(writesAFile(c), c).toBe(true);
    for (const c of [
      'npm install --no-fund 2>&1',
      'node --check src/public/app.js && echo ok',
      'npm test > /dev/null 2>&1; echo $?',
      'cat src/public/app.js; echo ---END---',
      'ls -la src/public',
      'wc -c src/public/app.js',
    ]) expect(writesAFile(c), c).toBe(false);
  });
});

describe('an app that dies at start', () => {
  it('is not reported running by app:restart: the model hears why', async () => {
    await start(fakeOctopod(true, 'restarting'));
    await bridge!.call({ conversation: 'c', calls: [call('a1', 'app:create', { stack: 'node-app' })] }, 5000);
    const reply = await bridge!.call({ conversation: 'c', calls: [call('r1', 'app:restart')] }, 5000);
    expect(reply.summary[0].status).toBe('error');
    expect(reply.text).toContain('restarting in a loop');
    expect(reply.text).toContain('line 1');
    expect(reply.text).not.toContain('running at');
  });
});

