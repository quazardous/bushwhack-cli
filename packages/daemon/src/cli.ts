/**
 * bushwhack — the command line.
 *
 * Most commands talk to the service (every project on one relay, one pairing), starting it
 * first when it is not running. `serve` is the older way: one folder, in this terminal.
 * `tools` and `call` speak the bridge the extension speaks, which is what makes the
 * protocol testable without a browser.
 */
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin } from 'node:process';
import { CALL_KEY, END_LINE } from '@bushwhack/protocol';
import { connectBridge } from './bridge-client.js';
import { AlreadyServing, serve, VERSION } from './serve.js';
import { describeSession, readEndpoint } from './session.js';
import { readHidden } from './approval.js';
import { DEFAULT_INSTANCE, INSTANCE_NAME, listInstances, startService, SERVICE, SERVICE_NODE, type ProjectEntry, type ServiceFile } from './service.js';
import { answers, ensureService, operatorClient } from './service-client.js';
import { runChatOnce, runChatTerminal, styleFor } from './chat-terminal.js';
import { listReports, markReport, type ListedReport } from './reports.js';
import { APP_MODES, configFile, readMode, writeMode, type AppMode } from './mode.js';
import { banner } from './banner.js';

const USAGE = `bushwhack ${VERSION}

  bushwhack                        here: share this folder (asked the first time), then answer
                                   approvals for every project in this terminal
  bushwhack add [folder]           let web chats work on this folder (the current one by default)
  bushwhack remove [folder]        stop that
  bushwhack list                   the projects, and the pairing code
  bushwhack approvals              answer the service's approval requests, in this terminal
  bushwhack daemon                 run the service in the foreground (systemd runs this)
  bushwhack instances              the service's instances: running or not, projects, browsers
  bushwhack reports [--all] [--new] [--json]
                                   the problems chats reported about bushwhack (report:bug):
                                   this project's, or every project's with --all
  bushwhack reports <ref>          one in full: <n> here, <project>:<n> anywhere
  bushwhack reports take|dismiss <ref> [note]
                                   say what became of it (taken: being worked on)

  --instance <name>                on any command: that instance (BUSHWHACK_INSTANCE too);
                                   by default, the one serving this folder, else "default"
  --yolo                           say yes to approvals by itself: with bushwhack, its project's;
                                   with bushwhack approvals, every project's (secret values are
                                   still typed by you)

  bushwhack mode [octopod|standalone]
                                   how a project gets its web app: through octopod (the app in
                                   its containers), or standalone (its files served as they are,
                                   nothing run) — set by setup; changing it restarts the service

  bushwhack serve [--new-code]     serve this folder alone, in this terminal
  bushwhack tools                  print the manifest the chat is given
  bushwhack call <tool> [k=v …]    run one call, as the chat would (a body is read from stdin)
`;

const WARNING = [
  '  Everything in this folder that is not ignored (.gitignore, .bushwhackignore) can be',
  '  read into a chat, and so sent to the chat provider. .git/ and ignored files cannot.',
];

/** The instance asked for (`--instance`, BUSHWHACK_INSTANCE); undefined when none was. */
let asked: string | undefined = process.env.BUSHWHACK_INSTANCE || undefined;
/** `--yolo`: every approval this terminal gets is a yes, without asking. */
let yolo = false;

/** The instance a folder is active in, when it is in one. */
async function instanceOf(folder: string): Promise<string | undefined> {
  return (await listInstances()).find((i) => i.projects.includes(folder))?.name;
}

async function reached(instance: string = asked ?? DEFAULT_INSTANCE): Promise<ServiceFile> {
  const { file, started } = await ensureService({ instance });
  if (started) console.log(`  started the bushwhack service${instance === DEFAULT_INSTANCE ? '' : ` "${instance}"`}, through ${started}`);
  return file;
}

async function withOperator<T>(run: (client: Awaited<ReturnType<typeof operatorClient>>) => Promise<T>, instance?: string): Promise<T> {
  const client = await operatorClient(await reached(instance), `cli:${process.pid}`);
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

function printProjects(projects: ProjectEntry[], code: string, approvalsHint = true): void {
  if (projects.length === 0) console.log('  no project yet — `bushwhack add` in a folder');
  const style = styleFor(Boolean(process.stdout.isTTY));
  const pad = ''.padEnd(20);
  for (const p of projects) {
    const chat = p.chat
      ? `${style.green(`● live in ${p.chat.chat ?? 'a web chat'}`)} ${style.dim(`— ${p.chat.browser}, ${p.chat.conversation ?? 'a new conversation'}`)}`
      : style.dim('○ no chat open');
    console.log(`  ${style.bold(p.session.padEnd(20))} ${style.dim(p.folder)}\n  ${pad} ${chat}\n  ${pad} ${style.dim(`app: ${p.app}`)}`);
  }
  console.log(`\n  pairing code  ${style.cyan(style.bold(code))}   ${style.dim('← lets a browser\'s extension in: typed once per browser, in the bushwhack panel (never in a chat)')}`);
  if (approvalsHint) console.log('  approvals     bushwhack approvals   ← keep it open in a terminal');
}

async function runAdd(folder: string): Promise<void> {
  const root = await realpath(resolve(folder));
  await withOperator(async (client) => {
    const { project, code } = (await client.add(root)) as { project: ProjectEntry; code: string };
    console.log(['', `  added ${project.session} — ${project.folder}`, '', ...WARNING, ''].join('\n'));
    printProjects([project], code);
  });
}

async function runRemove(folder: string): Promise<void> {
  const root = await realpath(resolve(folder));
  await withOperator(async (client) => {
    const { removed } = await client.remove(root);
    console.log(removed ? `  removed ${root}` : `  ${root} was not a project of the service`);
  }, asked ?? (await instanceOf(root)));
}

async function runInstances(): Promise<void> {
  const all = await listInstances();
  if (all.length === 0) return void console.log('  no instance yet — the first bushwhack command starts the default one');
  for (const i of all) {
    let state = 'stopped';
    let browsers = 0;
    if (i.file?.port) {
      const health = await fetch(`http://127.0.0.1:${i.file.port}/health`, { signal: AbortSignal.timeout(500) }).then((r) => r.json() as Promise<{ daemon?: string; connectedClients?: string[] }>, () => undefined);
      if (health?.daemon === i.file.id) {
        state = `running :${i.file.port}`;
        browsers = (health.connectedClients ?? []).filter((c) => c.startsWith('ext:')).length;
      }
    }
    const projects = `${i.projects.length} project${i.projects.length === 1 ? '' : 's'}`;
    console.log(`  ${i.name.padEnd(12)} ${state.padEnd(16)} ${projects.padEnd(12)} ${browsers} browser${browsers === 1 ? '' : 's'}`);
  }
}

async function runList(): Promise<void> {
  await withOperator(async (client) => {
    const { projects, code } = (await client.list()) as { projects: ProjectEntry[]; code: string };
    printProjects(projects, code);
  });
}

/**
 * `bushwhack mode`: say it; `bushwhack mode <mode>`: write it, and stop the running
 * services, which read it when they start — the next bushwhack command starts them again.
 */
async function runMode(rest: string[]): Promise<void> {
  const wanted = rest[0];
  if (wanted === undefined) {
    const mode = await readMode();
    console.log(`  ${mode}${mode === 'standalone' ? ": the projects' files served as they are, nothing run — no octopod" : ': the app through octopod, in its containers'}  (${configFile()})`);
    return;
  }
  if (!APP_MODES.includes(wanted as AppMode)) throw new Error(`the mode is ${APP_MODES.join(' or ')}, not "${wanted}"`);
  await writeMode(wanted as AppMode);
  console.log(`  mode: ${wanted}  (${configFile()})`);
  for (const instance of await listInstances()) {
    const pid = instance.file?.pid;
    // Only a service that answers as itself: the pid of one that stopped may be another process's now.
    if (!pid || !(await answers(instance.file))) continue;
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`  the ${instance.name} service stopped: the next bushwhack command starts it in this mode`);
    } catch {
      // not running
    }
  }
}

async function runDaemon(): Promise<void> {
  const service = await startService({ instance: asked ?? DEFAULT_INSTANCE });
  const stop = async (): Promise<void> => {
    await service.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

/**
 * `bushwhack` alone, in a folder: share it (asked, the first time), say where things stand,
 * then stay as the approvals terminal.
 */
async function runHere(): Promise<void> {
  process.stdout.write(banner(VERSION));
  const here = await realpath(process.cwd());
  // The instance serving this folder, if one does; else the one asked for, or chosen.
  let instance = asked ?? (await instanceOf(here));
  if (!instance && process.stdin.isTTY && here !== homedir() && here !== '/') {
    const all = (await listInstances()).filter((i) => i.file);
    if (all.length > 1) {
      console.log('\n  instances:');
      all.forEach((i, n) => console.log(`    ${n + 1}) ${i.name.padEnd(12)} ${i.projects.length} project${i.projects.length === 1 ? '' : 's'}`));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const pick = Number((await rl.question('  which one for this folder? [1] ')).trim() || '1');
      rl.close();
      instance = all[pick - 1]?.name;
      if (!instance) throw new Error('no such instance');
    }
  }
  const file = await reached(instance);
  const lister = await operatorClient(file, `cli:${process.pid}`);
  let { projects, code } = (await lister.list()) as { projects: ProjectEntry[]; code: string };
  const known = projects.some((p) => p.folder === here);
  if (!known && process.stdin.isTTY) {
    if (here === homedir() || here === '/') {
      console.log(`  ${here} is not shared: a chat would read all of it. Run bushwhack in a project folder, or bushwhack add <folder>.`);
    } else {
      console.log(['', `  ${here} is not shared with web chats yet.`, '', ...WARNING, '  Writes, edits, moves and deletes will wait for your yes, here.', ''].join('\n'));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('  Share this folder with web chats? [y/N] ')).trim().toLowerCase();
      rl.close();
      if (answer === 'y' || answer === 'yes') {
        const { project } = (await lister.add(here)) as { project: ProjectEntry };
        console.log(`  shared as ${project.session}`);
        ({ projects, code } = (await lister.list()) as { projects: ProjectEntry[]; code: string });
      }
    }
  }
  lister.close();
  const mine = projects.find((p) => p.folder === here);
  if (!process.stdin.isTTY) {
    // A script: a prompt on stdin gets the chat's finished answer on stdout.
    const prompt = (await readStdin())?.trim();
    if (prompt && mine) return void console.log(await runChatOnce(file, mine, prompt));
    if (prompt) throw new Error(`${here} is not shared: bushwhack add first`);
    return printProjects(projects, code);
  }
  console.log('');
  printProjects(projects, code, false);
  if (mine) {
    console.log('');
    await runChatTerminal({ file, project: mine, stateDir: join(here, '.bushwhack'), yolo });
    process.exit(0);
  }
  await runApprovals();
}

/** The operator's terminal for approvals: one question at a time, whatever the project. */
async function runApprovals(): Promise<void> {
  const file = await reached();
  const client = await operatorClient(file, `approvals:${randomBytes(4).toString('hex')}`, {
    lost: () => console.log('\n  the service is gone (restarted?) — reconnecting…'),
    back: async () => {
      await client.approvalsHere();
      console.log('  the service is back; approvals come here again\n');
    },
  });
  const { projects } = (await client.list()) as { projects: ProjectEntry[] };
  await client.approvalsHere();
  console.log(`\n  approvals for ${projects.length} project${projects.length === 1 ? '' : 's'} come here now; Ctrl-C to stop\n`);
  let queue: Promise<unknown> = Promise.resolve();
  const answer = (envelope: { source: string; id: string }, payload: Record<string, unknown>): void => {
    client.node.emit(SERVICE.approvalReply, { key: file.operatorKey, ...payload }, { target: envelope.source, replyToId: envelope.id });
  };
  client.node.on(SERVICE.notice, (payload: unknown, envelope) => {
    if (envelope.source !== SERVICE_NODE) return;
    const p = payload as { project?: unknown; text?: unknown };
    console.log(`\n  ${String(p.project)}: ${String(p.text)}  (bushwhack reports)`);
  });
  if (yolo) console.log('  --yolo: every approval is a yes, without asking — writes, deletes, app commands. Secret values are still yours to type.\n');
  client.node.on(SERVICE.approve, (payload: unknown, envelope) => {
    const p = payload as { project: string; id: string; tool: string; text: string };
    if (yolo) {
      answer(envelope, { verdict: 'yes' });
      process.stdout.write(`\n┌ yolo ${p.project} · ${p.id} ${p.tool}\n${String(p.text).replace(/^/gm, '│ ')}\n└ accepted\n`);
      return;
    }
    queue = queue.then(async () => {
      process.stdout.write(`\n┌ ${p.project} · ${p.id} ${p.tool}\n${String(p.text).replace(/^/gm, '│ ')}\n`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (;;) {
          const a = (await rl.question(`└ approve? [y]es / [n]o / [a]lways ${p.tool} for ${p.project}: `)).trim().toLowerCase();
          if (['y', 'yes'].includes(a)) return answer(envelope, { verdict: 'yes' });
          if (['n', 'no'].includes(a)) return answer(envelope, { verdict: 'no' });
          if (['a', 'always'].includes(a)) return answer(envelope, { verdict: 'always' });
        }
      } finally {
        rl.close();
      }
    });
  });
  client.node.on(SERVICE.secret, (payload: unknown, envelope) => {
    const p = payload as { project: string; id: string; file: string; name: string; description?: string };
    queue = queue.then(async () => {
      process.stdout.write(`\n┌ ${p.project} · ${p.id} secret:add — ${p.name} in ${p.file}\n${p.description ? `│ ${p.description}\n` : ''}│ the chat never sees what you type here\n└ value for ${p.name} (empty to refuse): `);
      const value = await readHidden(process.stdin);
      process.stdout.write('\n');
      answer(envelope, { value: value ?? '' });
    });
  });
  process.on('SIGINT', () => {
    client.close();
    process.exit(0);
  });
}

async function runServe(args: string[]): Promise<void> {
  const serving = await serve({ folder: process.cwd(), rotateCode: args.includes('--new-code') });
  const { session, port, code } = serving;
  console.log(
    [
      '',
      `  bushwhack ${VERSION} — serving ${session.folder}`,
      '',
      `  session       ${session.name}`,
      `  relay         ws://127.0.0.1:${port}`,
      `  pairing code  ${code}      ← type it in the bushwhack panel, never in the chat`,
      '',
      '  Everything in this folder that is not ignored (.gitignore, .bushwhackignore) can be',
      '  read into the chat, and so sent to the chat provider. .git/ and ignored files cannot.',
      '  Writes, edits, moves and deletes stop here for your approval.',
      '',
    ].join('\n'),
  );
  const stop = async (): Promise<void> => {
    await serving.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

/** The session of this folder: a `serve` running here, else the project of the instance serving it. */
async function client(): Promise<ReturnType<typeof connectBridge>> {
  const session = describeSession(await realpath(process.cwd()));
  const endpoint = await readEndpoint(session);
  const alive = endpoint && (await fetch(`http://127.0.0.1:${endpoint.port}/health`, { signal: AbortSignal.timeout(500) }).then((r) => r.json() as Promise<{ nodeId?: string }>, () => undefined))?.nodeId === session.nodeId;
  if (endpoint && alive) {
    return connectBridge({ port: endpoint.port, code: endpoint.code, daemonNodeId: session.nodeId, nodeId: `cli:${process.pid}`, client: 'cli' });
  }
  const file = await reached(asked ?? (await instanceOf(session.folder)));
  return connectBridge({ port: file.port!, code: file.code, daemonNodeId: session.nodeId, nodeId: `cli:${process.pid}`, client: 'cli' });
}

async function readStdin(): Promise<string | null> {
  if (stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function runCall(args: string[]): Promise<void> {
  const [tool, ...pairs] = args;
  if (!tool) throw new Error('usage: bushwhack call <tool> [key=value …]');
  const header = [`---`, `${CALL_KEY}: ${tool}`, `id: cli-${randomBytes(4).toString('hex')}`];
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new Error(`"${pair}" is not key=value`);
    header.push(`${pair.slice(0, eq)}: ${JSON.stringify(pair.slice(eq + 1))}`);
  }
  const body = await readStdin();
  const text = body === null ? [...header, END_LINE].join('\n') : [...header, '---', body.replace(/\n$/, ''), END_LINE].join('\n');

  const bridge = await client();
  try {
    console.log(`waiting for the session (an approval, if needed, is asked in the serve terminal or at bushwhack approvals)…`);
    const reply = await bridge.call({ conversation: 'cli', calls: [text] }, 10 * 60 * 1000);
    console.log(reply.text);
  } finally {
    bridge.close();
  }
}

async function runTools(): Promise<void> {
  const bridge = await client();
  try {
    console.log((await bridge.list()).manifest);
  } finally {
    bridge.close();
  }
}

/**
 * The chats' reports about bushwhack (report:bug), read from the projects' .bushwhack/ —
 * the service need not run. This folder's, or with --all every project of the instance's.
 *
 *   reports [--all] [--new] [--json]     list them
 *   reports <ref>                        one in full: <n> here, <project>:<n> anywhere
 *   reports take|dismiss <ref> [note…]   say what became of it
 */
async function runReports(args: string[]): Promise<void> {
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const [verb, ...words] = args.filter((a) => !a.startsWith('--'));
  const style = styleFor(Boolean(process.stdout.isTTY));
  const here = await realpath(process.cwd());
  const all = (await listInstances()).find((i) => i.name === (asked ?? DEFAULT_INSTANCE))?.projects ?? [];
  const projects = (folders: string[]): { name: string; folder: string }[] => folders.map((folder) => ({ name: describeSession(folder).name, folder }));
  const find = async (ref: string | undefined): Promise<ListedReport> => {
    const m = /^(?:([a-z0-9][a-z0-9-]*):)?(\d+)$/.exec(ref ?? '');
    if (!m) throw new Error('name a report: <n> for this folder\'s, <project>:<n> for another project\'s');
    const scope = m[1] ? projects(all).filter((p) => p.name === m[1]) : projects([here]);
    if (scope.length === 0) throw new Error(`no project "${m[1]}" in this instance`);
    const found = (await listReports(scope)).find((r) => r.n === Number(m[2]));
    if (!found) throw new Error(`no report ${ref}`);
    return found;
  };

  if (verb === 'take' || verb === 'dismiss') {
    const report = await find(words[0]);
    await markReport(join(report.folder, '.bushwhack'), report, verb === 'take' ? 'taken' : 'dismissed', words.slice(1).join(' ') || undefined);
    return console.log(`  ${report.project}:${report.n} ${verb === 'take' ? 'taken' : 'dismissed'}`);
  }
  if (verb !== undefined) {
    const r = await find(verb);
    if (flags.has('--json')) return console.log(JSON.stringify(r, null, 2));
    return console.log([
      `  ${r.kind === 'suggestion' ? '💡' : '🐞'} ${style.bold(r.title)}`,
      style.dim(`  ${r.project}:${r.n} · ${r.state}${r.note ? ` (${r.note})` : ''} · ${r.at} · ${r.conversation} · call ${r.id} · bushwhack ${r.version}`),
      '',
      r.text.replace(/^/gm, '  '),
      ...r.calls.flatMap((c) => ['', style.dim(`  ── ${c.id}${c.result ? ` ${c.result.tool} ${c.result.status}` : ' (not recorded)'}`), ...(c.result?.content ? [c.result.content.replace(/^/gm, '  │ ')] : [])]),
    ].join('\n'));
  }
  const listed = (await listReports(projects(flags.has('--all') ? all : [here]))).filter((r) => !flags.has('--new') || r.state === 'new');
  if (flags.has('--json')) return console.log(JSON.stringify(listed, null, 2));
  if (listed.length === 0) return console.log(`  no ${flags.has('--new') ? 'new ' : ''}report${flags.has('--all') ? ' in this instance\'s projects' : ' in this project'}`);
  const mark = (state: string): string => (state === 'new' ? style.cyan('new') : style.dim(state));
  for (const r of listed) console.log(`  ${style.bold(`${r.project}:${r.n}`.padEnd(18))} ${mark(r.state).padEnd(10)} ${style.dim(r.at.slice(0, 16).replace('T', ' '))}  ${r.kind === 'suggestion' ? '💡' : '🐞'} ${r.title}`);
  console.log(style.dim('\n  bushwhack reports <project>:<n> — one in full; take|dismiss <project>:<n> [note]'));
}

async function main(argv: string[]): Promise<void> {
  // `--instance <name>`, anywhere on the line.
  const at = argv.indexOf('--instance');
  if (at >= 0) {
    asked = argv[at + 1];
    if (!asked || !INSTANCE_NAME.test(asked)) throw new Error('--instance takes a name (a-z, 0-9 and -)');
    argv = [...argv.slice(0, at), ...argv.slice(at + 2)];
  }
  if (argv.includes('--yolo')) {
    yolo = true;
    argv = argv.filter((a) => a !== '--yolo');
  }
  const [command, ...rest] = argv;
  // The relay client's own traces (reconnect attempts…) would land in the middle of a
  // prompt; a terminal says what matters itself. The service keeps them, in its log.
  if (command !== 'daemon') console.debug = () => {};
  switch (command) {
    case undefined:
      return runHere();
    case 'add':
      return runAdd(rest[0] ?? '.');
    case 'remove':
      return runRemove(rest[0] ?? '.');
    case 'list':
      return runList();
    case 'approvals':
      return runApprovals();
    case 'daemon':
      return runDaemon();
    case 'instances':
      return runInstances();
    case 'reports':
      return runReports(rest);
    case 'serve':
      return runServe(rest);
    case 'call':
      return runCall(rest);
    case 'tools':
      return runTools();
    case 'mode':
      return runMode(rest);
    case 'version':
    case '--version':
      process.stdout.write(`bushwhack ${VERSION}\n`);
      return;
    default:
      process.stdout.write(USAGE);
      if (command !== 'help' && command !== '--help') process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof AlreadyServing ? e.message : `bushwhack: ${(e as Error).message}`);
  process.exit(1);
});
