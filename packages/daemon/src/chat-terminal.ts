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
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { CHAT, type ChatEvent } from '@bushwhack/protocol';
import { readHidden } from './approval.js';
import { SERVICE, SERVICE_NODE, type ProjectEntry, type ServiceFile } from './service.js';
import { operatorClient } from './service-client.js';

const HISTORY_MAX = 500;
/** How long after a finished answer nothing more comes before it is taken as the last. */
const SETTLE_MS = 6000;

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  cyan(s: string): string;
  green(s: string): string;
}

export function styleFor(tty: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (tty ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), cyan: wrap(36, 39) };
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

async function loadHistory(file: string): Promise<string[]> {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).slice(-HISTORY_MAX).reverse();
  } catch {
    return [];
  }
}

export interface ChatTerminalOptions {
  file: ServiceFile;
  project: ProjectEntry;
  /** The project's `.bushwhack/`: where its prompt history is kept. */
  stateDir: string;
  /** Say yes to every approval of this project, without asking — the operator's choice (`--yolo`). */
  yolo?: boolean;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/** The interactive chat. Resolves when the operator leaves (/quit, Ctrl-D). */
export async function runChatTerminal(options: ChatTerminalOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const style = styleFor(Boolean(output.isTTY));
  const historyFile = join(options.stateDir, 'history');
  const { project } = options;
  // An approvals: node, so the approvals of every project come here too.
  const client = await operatorClient(options.file, `approvals:${randomBytes(4).toString('hex')}`, {
    lost: () => {
      setBusy(undefined);
      say(style.red('  ✻ the service is gone (restarted?) — reconnecting…'));
    },
    // A new service knows neither the chat this terminal follows nor where approvals go.
    back: async () => {
      await client.chatAttach(project.nodeId);
      await client.approvalsHere();
      say(style.dim('  ✻ the service is back'));
    },
  });
  await client.chatAttach(project.nodeId);
  await client.approvalsHere();

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

  /** Print above the prompt, then give the prompt back — nothing once the terminal is left. */
  const say = (text: string): void => {
    if (leaving) return;
    output.write(`\r\x1b[2K${text}\n`);
    if (busy) output.write(`${busyLine()}\n`);
    rl.prompt(true);
  };

  const onLine = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (line === '') return rl.prompt();
    await appendFile(historyFile, `${line.replace(/\n/g, ' ')}\n`).catch(() => undefined);
    if (line.startsWith('/')) {
      const [command] = line.split(/\s+/);
      if (command === '/quit' || command === '/exit') return rl.close();
      if (command === '/help') return say(style.dim('  type a prompt to send it to the chat bound to this project\n  /manifest send the chat the tools manifest: what bushwhack is, and how to call it\n  /status   the instance, the browsers and where prompts go, the projects\n  /quit     leave (Ctrl-D too)'));
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
        return say([...whereLines(view, project, style), '', ...view.projects.map((p) => `  ${p.session === project.session ? style.bold(p.session) : p.session}  ${style.dim(p.folder)}`)].join('\n'));
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
  client.node.on(SERVICE.notice, (payload: unknown, envelope) => {
    if (envelope.source !== SERVICE_NODE) return;
    const p = payload as { project?: unknown; text?: unknown };
    say(`  ${style.bold(String(p.project))}: ${String(p.text)} ${style.dim('(bushwhack reports)')}`);
  });
  client.node.on(SERVICE.approve, (payload: unknown, envelope) => {
    const p = payload as { project: string; id: string; tool: string; text: string };
    // --yolo is for this terminal's project only: another's approval is asked, as ever.
    if (options.yolo && p.project === project.session) {
      // Shown all the same: what was done in the operator's name stays in sight.
      answer(envelope, { verdict: 'yes' });
      say(`${style.red('┌ yolo')} ${p.project} · ${p.id} ${p.tool}\n${style.dim(String(p.text).replace(/^/gm, '│ '))}\n${style.red('└ accepted')}`);
      return;
    }
    approvals = approvals.then(
      () =>
        new Promise<void>((resolve) => {
          asking = true;
          output.write(`\r\x1b[2K\n┌ ${p.project} · ${p.id} ${p.tool}\n${String(p.text).replace(/^/gm, '│ ')}\n`);
          const ask = (): void =>
            rl.question(`└ approve? [y]es / [n]o / [a]lways ${p.tool} for ${p.project}: `, (a) => {
              const v = a.trim().toLowerCase();
              const verdict = ['y', 'yes'].includes(v) ? 'yes' : ['n', 'no'].includes(v) ? 'no' : ['a', 'always'].includes(v) ? 'always' : undefined;
              if (!verdict) return ask();
              answer(envelope, { verdict });
              asking = false;
              rl.prompt();
              resolve();
            });
          ask();
        }),
    );
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
      rl.prompt();
    });
  });

  open();
  output.write(`${whereLines((await client.list()) as unknown as ServiceView, project, style).join('\n')}\n\n`);
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
