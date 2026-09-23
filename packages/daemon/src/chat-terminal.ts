/**
 * The terminal chat: `bushwhack` in a project folder, once the folder is shared.
 *
 * What is typed goes to the web chat bound to the project (through the service and the
 * extension); what the chat shows comes back — the model's answer, the calls it made and
 * their results. Approvals for every project are answered here too. The web chat stays
 * the engine and the page the source of truth; this is its terminal face.
 *
 * Display grammar: `● tool(detail)` for a call, `  ⎿  status` for its result, a status
 * line rewritten in place while the model answers.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { CHAT, type ChatEvent } from '@bushwhack/protocol';
import { askTerminal, readHidden } from './approval.js';
import type { Scope } from './approval-rules.js';
import { SERVICE, SERVICE_NODE, type ProjectEntry, type ServiceFile } from './service.js';
import { operatorClient } from './service-client.js';

const HISTORY_MAX = 500;
/** How long after a finished answer nothing more comes before it is taken as the last. */
const SETTLE_MS = 6000;

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  green(s: string): string;
}

export function styleFor(tty: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (tty ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), cyan: wrap(36, 39), yellow: wrap(33, 39) };
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** A light markdown rendering: headings, lists, code blocks, bold and inline code. */
export function renderMarkdown(text: string, style: Style): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const opening = /^\s*```(\S*)/.exec(line);
    if (opening) {
      if (fence === undefined) {
        fence = opening[1];
        out.push(style.dim(`  ┌─${fence ? ` ${fence} ` : ''}`));
      } else {
        fence = undefined;
        out.push(style.dim('  └─'));
      }
      continue;
    }
    if (fence !== undefined) {
      out.push(`${style.dim('  │ ')}${line}`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(style.bold(heading[2]));
      continue;
    }
    out.push(
      line
        .replace(/^(\s*)[-*]\s+/, '$1• ')
        .replace(/\*\*([^*]+)\*\*/g, (_, t: string) => style.bold(t))
        .replace(/`([^`]+)`/g, (_, t: string) => style.cyan(t)),
    );
  }
  return out.join('\n');
}

/** One event, as the terminal shows it. */
export function renderEvent(event: ChatEvent, style: Style): string | undefined {
  switch (event.kind) {
    case 'answer':
      if (!event.done) return undefined;
      // Finished with nothing to read — still finished: say so, the counter stops.
      return event.text?.trim() ? renderMarkdown(event.text, style) : style.dim('  ✻ the model answered, with nothing to read');
    case 'calls':
      return (event.items ?? []).map((i) => `${style.cyan('●')} ${style.bold(i.tool)}${i.detail ? `(${i.detail})` : ''}`).join('\n');
    case 'results':
      return (event.items ?? [])
        .map((i) => {
          const line = `  ⎿  ${i.id ?? '?'} ${i.status ?? ''}${i.detail ? ` — ${i.detail}` : ''}`;
          return i.status?.startsWith('ok') ? style.dim(line) : style.red(line);
        })
        .join('\n');
    case 'notice':
      return style.dim(`  ${event.text ?? ''}`);
    case 'chat':
      return event.text
        ? `  ${style.cyan('⇄')} prompts now go to ${style.bold(event.text)}`
        : `  ${style.red('⇄')} no chat holds this project any more — open its chat, or bind one in the bushwhack panel`;
  }
}

/**
 * What the spinner says after a chat event: what the model is doing, in the words that
 * fit — writing text, calls running, results on their way back — and nothing once its
 * answer is done. An answer made of calls only has no text to count.
 */
export function busyAfter(event: ChatEvent, busy: string | undefined): string | undefined {
  switch (event.kind) {
    case 'answer':
      if (event.done) return undefined;
      return event.text ? `the model is writing… ${event.text.length} characters` : (busy ?? 'the model is answering…');
    case 'calls': {
      const n = event.items?.length ?? 0;
      return `running ${n} call${n === 1 ? '' : 's'}…`;
    }
    case 'results':
      return 'results sent — the model goes on…';
    default:
      return busy;
  }
}

export interface ServiceView {
  instance?: string;
  port?: number;
  projects: ProjectEntry[];
  browsers?: { node: string; browser: string; dev: boolean; chats: string[] }[];
}

/** Where this terminal is: which instance, which browsers, and where its prompts go. */
export function whereLines(view: ServiceView, project: ProjectEntry, style: Style): string[] {
  const lines = [`  instance  ${style.bold(view.instance ?? 'default')}${view.port ? style.dim(` :${view.port}`) : ''}`];
  const browsers = view.browsers ?? [];
  if (browsers.length === 0) lines.push(`  browser   ${style.red('none connected')} — pair one in the bushwhack panel`);
  for (const b of browsers) {
    const holds = b.chats.includes(project.session);
    const others = b.chats.filter((c) => c !== project.session);
    lines.push(
      `  browser   ${b.browser}${b.dev ? style.dim(' (dev extension)') : ''}` +
        (holds ? ` ${style.cyan(`← ${project.session}'s chat is open here: prompts go here`)}` : '') +
        (others.length ? style.dim(`  (also: ${others.join(', ')})`) : ''),
    );
  }
  const live = view.projects.find((p) => p.nodeId === project.nodeId)?.chat;
  if (live) {
    lines.push(`  chat      ${style.bold(live.chat ?? 'a web chat')} ${style.dim(`— ${live.conversation ?? 'a new conversation'}`)}`);
    lines.push(style.dim('            keep the browser window in sight: a hidden one runs the chat slowly (Meta AI does not even load its message box)'));
  }
  if (browsers.length > 0 && !browsers.some((b) => b.chats.includes(project.session))) {
    lines.push(`  ${style.red(`no browser has ${project.session}'s chat open`)} — open a chat, bind it to ${project.session} in the bushwhack panel`);
  }
  return lines;
}

/** How much of a `!command`'s output goes to the chat: its end, where errors and results are. */
const SHELL_MAX = 20_000;

/** A `!command` and its output, as the chat gets them. */
export function shellMessage(command: string, output: string, code: number | null): string {
  // eslint-disable-next-line no-control-regex
  let text = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n').trimEnd();
  if (text.length > SHELL_MAX) text = `… (${text.length - SHELL_MAX} characters before, cut)\n${text.slice(-SHELL_MAX)}`;
  const fence = text.includes('```') ? '~~~~' : '```';
  const status = code === null ? ' (it could not run)' : code === 0 ? '' : ` (exit code ${code})`;
  return [`I ran this in the project's folder${status}:`, '', fence, `$ ${command}`, ...(text ? [text] : ['(no output)']), fence].join('\n');
}

/** Where this terminal's project asks for approvals — said when it opens, and by /status. */
export function approvalLines(approveHere: boolean, style: Style): string[] {
  if (approveHere) return [`  approvals ${style.bold('in this terminal')} ${style.dim('(--approve-here) — each change asks here, with its diff')}`];
  return [
    `  approvals ${style.yellow('in the browser')} — each change pops up a notification (Yes / No); a click on it shows the whole diff`,
    style.dim('            to answer them in this terminal instead: bushwhack --approve-here'),
  ];
}

async function loadHistory(file: string): Promise<string[]> {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).slice(-HISTORY_MAX).reverse();
  } catch {
    return [];
  }
}

/** The answers remembered, as the service lists them (`/always`, `bushwhack approvals --always`). */
export interface RulesReply {
  rules: { project: string; rule: string; answer: 'yes' | 'no' }[];
  forgotten: { project: string; rule: string; answer: 'yes' | 'no' }[];
  errors?: { project: string; error: string }[];
}

export function ruleLines(r: RulesReply, withProject: boolean): string[] {
  const name = (x: { project: string }): string => (withProject ? `${x.project}: ` : '');
  const says = (x: { answer: string; rule: string }): string => `${x.answer === 'yes' ? 'always' : 'never '} ${x.rule}`;
  return [
    ...(r.errors ?? []).map((e) => `  ⚠ ${name(e)}${e.error}`),
    ...r.forgotten.map((f) => `  forgotten: ${name(f)}${says(f)} — asked again from now`),
    ...(r.rules.length > 0 ? r.rules.map((x) => `  ${name(x)}${says(x)}`) : ['  no answer remembered — every call is asked']),
    '  (kept in each project\'s .bushwhack/approval-rules.json)',
  ];
}

export interface ChatTerminalOptions {
  file: ServiceFile;
  project: ProjectEntry;
  /** The project's `.bushwhack/`: where its prompt history is kept. */
  stateDir: string;
  /** Say yes to every approval of this project, without asking — the operator's choice (`--yolo`). */
  yolo?: boolean;
  /**
   * Take the approvals here (`--approve-here`; `--yolo` implies it): of this project, and of
   * the others when no other terminal takes them. Without it they are asked in the browser,
   * and this terminal only says where they stand.
   */
  approveHere?: boolean;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/** How a terminal names itself to the panel: its pid, and its tty where one is known. */
export function terminalLabel(pid = process.pid): string {
  let tty = '';
  try {
    tty = readlinkSync('/proc/self/fd/0');
  } catch {
    // not Linux, or no tty: the pid says enough
  }
  return `pid ${pid}${tty.startsWith('/dev/') ? ` · ${tty.slice(5)}` : ''}`;
}

/** The interactive chat. Resolves when the operator leaves (/quit, Ctrl-D). */
export async function runChatTerminal(options: ChatTerminalOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const style = styleFor(Boolean(output.isTTY));
  const historyFile = join(options.stateDir, 'history');
  const { project } = options;
  const approveHere = options.approveHere === true || options.yolo === true;
  // Taking approvals: an approvals: node, so the approvals of every project come here too.
  const client = await operatorClient(options.file, `${approveHere ? 'approvals' : 'chat'}:${randomBytes(4).toString('hex')}`, {
    lost: () => {
      setBusy(undefined);
      say(style.red('  ✻ the service is gone (restarted?) — reconnecting…'));
    },
    // A new service knows neither the chat this terminal follows nor where approvals go.
    back: async () => {
      if (approveHere) await client.approvalsHere();
      await client.chatAttach(project.nodeId, terminalLabel());
      say(style.dim('  ✻ the service is back'));
    },
  });
  let rl: Interface;
  // While the chat answers: a spinner and the time it has taken, on the line above the prompt.
  let busy: string | undefined;
  let busySince = 0;
  let frame = 0;
  let spinner: NodeJS.Timeout | undefined;
  let asking = false;
  const busyLine = (): string =>
    style.dim(`  ${output.isTTY ? SPINNER[frame % SPINNER.length] : '✻'} ${busy} · ${Math.round((Date.now() - busySince) / 1000)}s`);
  const setBusy = (text: string | undefined): void => {
    if (text && !busy) busySince = Date.now();
    busy = text;
    if (busy && output.isTTY && !spinner) {
      spinner = setInterval(() => {
        frame++;
        // Save the cursor, redraw the line above, put the cursor back: what is typed stays.
        if (busy && !asking && !suspended) output.write(`\x1b7\x1b[1A\r\x1b[2K${busyLine()}\x1b8`);
      }, 120);
    } else if (!busy && spinner) {
      clearInterval(spinner);
      spinner = undefined;
    }
  };
  const history = await loadHistory(historyFile);
  const open = (): void => {
    rl = createInterface({ input, output, history, historySize: HISTORY_MAX, prompt: `${style.cyan('❯')} ` });
    rl.on('line', (line) => void onLine(line));
    rl.on('close', () => closing());
  };
  let leaving = false;
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => (done = r));
  const closing = (): void => {
    if (leaving || suspended) return;
    leaving = true;
    setBusy(undefined);
    client.close();
    output.write('\n');
    done();
  };
  let suspended = false;

  /** What arrived while the prompt was stepped aside (a `!command`, a secret value): said after. */
  const held: string[] = [];
  /** Print above the prompt, then give the prompt back — nothing once the terminal is left. */
  const say = (text: string): void => {
    if (leaving) return;
    if (suspended) {
      held.push(text);
      return;
    }
    output.write(`\r\x1b[2K${text}\n`);
    if (busy) output.write(`${busyLine()}\n`);
    rl.prompt(true);
  };

  const onLine = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (line === '') return rl.prompt();
    await appendFile(historyFile, `${line.replace(/\n/g, ' ')}\n`).catch(() => undefined);
    if (line.startsWith('!')) {
      const command = line.slice(1).trim();
      if (command === '') return say(style.dim('  !<command> runs it in the project\'s folder, then sends it and its output to the chat'));
      // In turn with the approvals: none writes over the command, and it waits for none.
      approvals = approvals.then(() => runLocal(command));
      return;
    }
    if (line.startsWith('/')) {
      const [command] = line.split(/\s+/);
      if (command === '/quit' || command === '/exit') return rl.close();
      if (command === '/help') return say(style.dim('  type a prompt to send it to the chat bound to this project\n  !<cmd>    run a shell command in the project\'s folder; it and its output go to the chat (secrets masked)\n  /manifest send the chat the tools manifest: what bushwhack is, and how to call it\n  /status   the instance, the browsers and where prompts go, the projects\n  /always   the answers remembered here; /always forget <rule, pattern or tool>, or /always forget all\n  /quit     leave (Ctrl-D too)'));
      if (command === '/always') {
        const [, verb, ...named] = line.split(/\s+/);
        const what = named.join(' ');
        const forget = verb === 'forget' ? (what === 'all' || !what ? true : what) : undefined;
        try {
          return say(style.dim(ruleLines((await client.always(project.nodeId, forget)) as unknown as RulesReply, false).join('\n')));
        } catch (e) {
          return say(style.red(`  ${(e as Error).message}`));
        }
      }
      if (command === '/manifest') {
        try {
          const reply = (await client.chatManifest(project.nodeId)) as { conversation?: string };
          setBusy('the model is answering…');
          return say(style.dim(`  ⎿  tools manifest sent to ${reply.conversation ?? 'the chat'}`));
        } catch (e) {
          return say(style.red(`  ${(e as Error).message}`));
        }
      }
      if (command === '/status') {
        const view = (await client.list()) as unknown as ServiceView;
        return say([...whereLines(view, project, style), ...approvalLines(approveHere, style), '', ...view.projects.map((p) => `  ${p.session === project.session ? style.bold(p.session) : p.session}  ${style.dim(p.folder)}`)].join('\n'));
      }
      return say(style.red(`  unknown: ${command} — /help`));
    }
    try {
      const reply = (await client.chatSend(project.nodeId, line)) as { conversation?: string };
      setBusy('the model is answering…');
      say(style.dim(`  ⎿  sent to ${reply.conversation ?? 'the chat'}`));
    } catch (e) {
      say(style.red(`  ${(e as Error).message}`));
    }
  };

  /**
   * `!command`: the operator's own shell, in the project's folder. Its output shows here as it
   * comes, then the command and its output go to the chat — through the service, which masks
   * the project's secrets in it. The prompt steps aside meanwhile; what arrives is said after.
   */
  const runLocal = async (command: string): Promise<void> => {
    suspended = true;
    rl.close();
    output.write(`\r\x1b[2K${style.dim(`  $ ${command}`)}\n`);
    let captured = '';
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(command, { cwd: project.folder, shell: process.env.SHELL || true, stdio: ['inherit', 'pipe', 'pipe'] });
      const take = (chunk: Buffer): void => {
        output.write(chunk);
        captured += chunk.toString('utf8');
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('close', (c) => resolve(c));
      child.on('error', (e) => {
        captured += `${e.message}\n`;
        output.write(style.red(`  ${e.message}\n`));
        resolve(null);
      });
    });
    if (code) output.write(style.dim(`  ⎿ exit ${code}\n`));
    suspended = false;
    open();
    for (const text of held.splice(0)) say(text);
    try {
      const reply = (await client.chatSendShell(project.nodeId, shellMessage(command, captured, code))) as { conversation?: string };
      setBusy('the model is answering…');
      say(style.dim(`  ⎿  the command and its output sent to ${reply.conversation ?? 'the chat'}`));
    } catch (e) {
      say(style.red(`  not sent to the chat: ${(e as Error).message}`));
    }
  };

  client.node.on(CHAT.event, (payload: unknown) => {
    const event = payload as ChatEvent;
    if (event.session !== project.nodeId) return;
    const next = busyAfter(event, busy);
    if (next !== busy) setBusy(next);
    const shown = renderEvent(event, style);
    if (shown) say(shown);
  });

  // Approvals, one at a time, in the same terminal.
  let approvals: Promise<unknown> = Promise.resolve();
  const answer = (envelope: { source: string; id: string }, payload: Record<string, unknown>): void => {
    client.node.emit(SERVICE.approvalReply, { key: options.file.operatorKey, ...payload }, { target: envelope.source, replyToId: envelope.id });
  };
  // Closed from a browser's panel (the operator confirmed it there): say so, and leave.
  client.node.on(SERVICE.close, (payload: unknown, envelope) => {
    if (envelope.source !== SERVICE_NODE) return;
    say(style.red(`  ✻ closed from the bushwhack panel, in ${String((payload as { by?: unknown })?.by ?? 'a browser')}`));
    rl.close();
  });
  client.node.on(SERVICE.notice, (payload: unknown, envelope) => {
    if (envelope.source !== SERVICE_NODE) return;
    const p = payload as { project?: unknown; text?: unknown; approval?: unknown };
    // A call accepted by an "always" rule: said, in the flow of the calls.
    if (p.approval === true) return say(style.dim(`  ${String(p.text)}`));
    say(`  ${style.bold(String(p.project))}: ${String(p.text)} ${style.dim('(bushwhack reports)')}`);
  });
  client.node.on(SERVICE.approve, (payload: unknown, envelope) => {
    const p = payload as { project: string; id: string; tool: string; text: string; scopes?: Scope[] };
    // --yolo is for this terminal's project only: another's approval is asked, as ever.
    if (options.yolo && p.project === project.session) {
      // Shown all the same: what was done in the operator's name stays in sight.
      answer(envelope, { verdict: 'yes', yolo: true });
      say(`${style.red('┌ yolo')} ${p.project} · ${p.id} ${p.tool}\n${style.dim(String(p.text).replace(/^/gm, '│ '))}\n${style.red('└ accepted')}`);
      return;
    }
    approvals = approvals.then(async () => {
      asking = true;
      output.write(`\r\x1b[2K\n┌ ${p.project} · ${p.id} ${p.tool}\n${String(p.text).replace(/^/gm, '│ ')}\n`);
      const question = (prompt: string): Promise<string> => new Promise((r) => rl.question(prompt, r));
      answer(envelope, { ...(await askTerminal(question, (text) => output.write(text), p.scopes)) });
      asking = false;
      rl.prompt();
    });
  });
  client.node.on(SERVICE.secret, (payload: unknown, envelope) => {
    const p = payload as { project: string; id: string; file: string; name: string; description?: string };
    approvals = approvals.then(async () => {
      // The line editor echoes; the secret must not be: close it, read raw, open it again.
      suspended = true;
      rl.close();
      output.write(`\r\x1b[2K\n┌ ${p.project} · ${p.id} secret:add — ${p.name} in ${p.file}\n${p.description ? `│ ${p.description}\n` : ''}│ the chat never sees what you type here\n└ value for ${p.name} (empty to refuse): `);
      const value = await readHidden(input);
      output.write('\n');
      answer(envelope, { value: value ?? '' });
      suspended = false;
      open();
      for (const text of held.splice(0)) say(text);
      rl.prompt();
    });
  });

  open();
  // Only now, every handler in place, take the approvals — one sent sooner would reach a
  // terminal not listening yet, and wait for ever — then attach, which may wait a moment for
  // the browsers to say which chat they show.
  if (approveHere) await client.approvalsHere();
  await client.chatAttach(project.nodeId, terminalLabel());
  output.write(`${[...whereLines((await client.list()) as unknown as ServiceView, project, style), ...approvalLines(approveHere, style)].join('\n')}\n\n`);
  if (options.yolo) output.write(`${style.red(`  --yolo: every approval for ${project.session} is a yes, without asking — writes, deletes, app commands. Other projects' are asked; secret values are still yours to type.`)}\n\n`);
  output.write(style.dim(`  chat of ${project.session} — type a prompt; /status; /help; Ctrl-D to leave\n`));
  rl!.prompt();
  await finished;
}

/** No terminal: one prompt from stdin, the finished answer on stdout. */
export async function runChatOnce(file: ServiceFile, project: ProjectEntry, text: string, timeoutMs = 10 * 60_000, settleMs = SETTLE_MS): Promise<string> {
  const client = await operatorClient(file, `cli:${randomBytes(4).toString('hex')}`);
  try {
    await client.chatAttach(project.nodeId);
    // The answer is the last one written: a model that makes calls answers again once their
    // results are back. Settled when a finished answer is followed by nothing for a while.
    const answered = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer from the chat in time')), timeoutMs);
      let settle: NodeJS.Timeout | undefined;
      let last = '';
      client.node.on(CHAT.event, (payload: unknown) => {
        const event = payload as ChatEvent;
        if (event.session !== project.nodeId) return;
        if (settle) clearTimeout(settle);
        settle = undefined;
        if (event.kind === 'answer' && event.done) {
          last = event.text ?? '';
          settle = setTimeout(() => {
            clearTimeout(timer);
            resolve(last);
          }, settleMs);
        }
      });
    });
    await client.chatSend(project.nodeId, text);
    return await answered;
  } finally {
    client.close();
  }
}
