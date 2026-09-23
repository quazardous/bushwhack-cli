/**
 * The service: every project on one relay, in one process — started once (by systemd
 * --user, or by the first `bushwhack` command), paired once by the extension.
 *
 * Each project keeps what `serve` gives it — its jail, its `.bushwhack/`, its secrets, its
 * replay store, its app — as a session node of its own; the process is all they share.
 * There is no terminal: approvals and secret values go to `bushwhack approvals`, a client
 * that proves it acts for the operator with the operator key — a 0600 file the extension
 * never sees, so nothing that reaches the relay through a chat page can approve anything.
 */
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { HubNode, WebSocketTransport, type HubEnvelope } from '@bushwhack/hub';
import { APPROVAL, CHAT, EXTENSION_NODE_PREFIX, type ChatEvent, type ChatTerminals, type SessionHealth } from '@bushwhack/protocol';
import type { RelayServer } from '@bushwhack/relay';
import { preview } from './approval.js';
import type { Approver, Refusal, ToolRun, Verdict } from './dispatcher.js';
import { decide, describeRule, kindOf, matches, patternProblem, rememberable, RULES_FILE, RuleStore, scopesFor, takesPattern, type Answer, type Rule } from './approval-rules.js';
import { octopodCli, type OctopodClient } from './octopod-client.js';
import { listenRelay } from './serve.js';
import { describeSession, newPairingCode } from './session.js';
import { openSession, type OpenSession } from './session-node.js';
import { readMode } from './mode.js';
import { ProjectSites } from './site.js';
import type { Workspace } from '@bushwhack/workspace';

/** The service's own node on its relay: where the CLI and the approvals client talk to it. */
export const SERVICE_NODE = 'service:bushwhack';
/** Approvals clients register as `approvals:<random>`. */
export const APPROVALS_PREFIX = 'approvals:';

export const SERVICE = {
  add: 'service:add',
  remove: 'service:remove',
  list: 'service:list',
  reply: 'service:reply',
  /** service → approvals client: a call to approve. */
  approve: 'approval:ask',
  /** service → approvals client: a secret value to type. */
  secret: 'approval:secret',
  approvalReply: 'approval:reply',
  /** approvals client → service: "send them to me" — the latest terminal opened wins. */
  approvalsHere: 'approval:here',
  /** terminal → service: show me this project's chat. */
  chatAttach: 'service:chat-attach',
  /** terminal → service: send this prompt to this project's chat. */
  chatSend: 'service:chat-send',
  /** service → approvals client: a line to show, nothing to answer (a report:bug). */
  notice: 'approval:notice',
  /** terminal → service: the "always" rules given, per project — or forget some. */
  always: 'service:always',
  /** service → terminal: leave — closed from a browser's panel. */
  close: 'service:close',
} as const;

/** How long a call waits for someone at `bushwhack approvals` before it is refused. */
export const APPROVAL_WAIT_MS = 10 * 60_000;

export interface ServiceFile {
  id: string;
  /** Its instance name: `default`, or another (`dev`…) running beside it. */
  instance?: string;
  /** The pairing code: one for every project of the service. */
  code: string;
  /** Proves a client acts for the operator: approvals, add, remove. Never leaves this file. */
  operatorKey: string;
  port?: number;
  pid?: number;
}

export const DEFAULT_INSTANCE = 'default';
export const INSTANCE_NAME = /^[a-z][a-z0-9-]{0,20}$/;

function stateBase(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'bushwhack');
}

/** Where an instance keeps its state: `service/` for the default one, `service-<name>/` for the others. */
export function instanceDir(instance: string = DEFAULT_INSTANCE, env: NodeJS.ProcessEnv = process.env): string {
  if (!INSTANCE_NAME.test(instance)) throw new Error(`"${instance}" is not an instance name (a-z, 0-9 and -, from a letter)`);
  return join(stateBase(env), instance === DEFAULT_INSTANCE ? 'service' : `service-${instance}`);
}

export function serviceDir(env: NodeJS.ProcessEnv = process.env): string {
  return instanceDir(DEFAULT_INSTANCE, env);
}

/** Every instance this user has run: its name, its folder, its file when it has one. */
export async function listInstances(env: NodeJS.ProcessEnv = process.env): Promise<{ name: string; dir: string; file?: ServiceFile; projects: string[] }[]> {
  const base = stateBase(env);
  const names = await readdir(base).catch(() => [] as string[]);
  const out = [];
  for (const entry of names.sort()) {
    const name = entry === 'service' ? DEFAULT_INSTANCE : entry.startsWith('service-') ? entry.slice('service-'.length) : undefined;
    if (!name || !INSTANCE_NAME.test(name)) continue;
    const dir = join(base, entry);
    const file = await readServiceFile(dir);
    const projects = await readFile(join(dir, 'projects.json'), 'utf8').then((t) => JSON.parse(t) as string[], () => []);
    out.push({ name, dir, projects, ...(file ? { file } : {}) });
  }
  return out;
}

export async function readServiceFile(dir: string): Promise<ServiceFile | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'service.json'), 'utf8')) as ServiceFile;
  } catch {
    return undefined;
  }
}

async function writeServiceFile(dir: string, file: ServiceFile): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'service.json'), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
}

export interface ServiceOptions {
  /** `default` unless said. */
  instance?: string;
  dir?: string;
  ports?: number[];
  octopod?: OctopodClient;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  approvalWaitMs?: number;
  /** How long a browser's chat counts as open after its last heartbeat; 90 s unless a test says. */
  presenceMs?: number;
  /** Standalone mode: the ports to try for the projects' sites; the mode itself is read from the config. */
  sitePorts?: number[];
}

export interface ProjectEntry {
  session: string;
  folder: string;
  nodeId: string;
  app: string;
  /** The app's address, when the project has an app: the panel offers to open it. */
  url?: string;
  /** In `list` only: the chat the project is live in right now — its browser, which chat (Meta AI, Gemini…), which conversation. */
  chat?: LiveChat;
}

export interface LiveChat {
  browser: string;
  chat?: string;
  conversation?: string;
}

/** "Gemini in Chromium 153 — gemini.google.com/eeae…", or "Meta AI in Chrome — a new conversation". */
export function describeChat(chat: LiveChat): string {
  const where = chat.conversation ? chat.conversation : 'a new conversation';
  return `${chat.chat ?? 'a web chat'} in ${chat.browser} — ${where}`;
}

export interface Service {
  id: string;
  port: number;
  code: string;
  add(folder: string): Promise<ProjectEntry>;
  remove(folder: string): Promise<boolean>;
  list(): ProjectEntry[];
  close(): Promise<void>;
}

/** octopod's answers that do not change from one project to the next, asked once a minute at most. */
function memoOctopod(octopod: OctopodClient): OctopodClient {
  const memo = new Map<string, { at: number; value: Promise<unknown> }>();
  const once = <T>(key: string, ask: () => Promise<T>): Promise<T> => {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value as Promise<T>;
    const value = ask();
    memo.set(key, { at: Date.now(), value });
    value.catch(() => memo.delete(key));
    return value;
  };
  return Object.assign(Object.create(octopod) as OctopodClient, {
    available: () => once('available', () => octopod.available()),
    ...(octopod.check ? { check: () => once('check', () => octopod.check!()) } : {}),
    recipes: () => once('recipes', () => octopod.recipes()),
  });
}

/**
 * Approvals asked of whoever runs `bushwhack approvals`, for one project. "always" is kept
 * for the service's life only — a restart asks again — and every decision, whoever made
 * it, goes to the project's `.bushwhack/approvals.jsonl`.
 */
/** Paths compare without case where the file system does. */
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const RULES_PATH = `.bushwhack/${RULES_FILE}`;

class RemoteApprover implements Approver {
  /** The answers the operator asked to remember, in the project's `.bushwhack/approval-rules.json`. */
  readonly rules: RuleStore;
  /** The rules file's last error, said once — not at every call. */
  private said?: string;

  private async log(call: ToolRun & { id: string }, verdict: Verdict, by: 'operator' | 'browser' | 'rule' | 'yolo' | 'nobody', rule?: Rule): Promise<void> {
    const line = { at: new Date().toISOString(), id: call.id, tool: call.tool, ...(call.args.path ? { path: String(call.args.path) } : {}), verdict, by, ...(rule ? { rule: describeRule(rule) } : {}) };
    await appendFile(join(describeSession(this.workspace.root).stateDir, 'approvals.jsonl'), JSON.stringify(line) + '\n', { mode: 0o600 }).catch(() => undefined);
  }

  constructor(
    private readonly ask_: (kind: string, payload: Record<string, unknown>, session?: string) => Promise<Record<string, unknown> | undefined>,
    private readonly project: string,
    private readonly workspace: Workspace,
    private readonly extraPreview: (call: ToolRun) => Promise<string> | undefined,
    private readonly out: (line: string) => void,
    private readonly tell: (kind: string, payload: Record<string, unknown>, session?: string) => void = () => {},
    /** The project's node: its approvals go first to a terminal following its chat. */
    private readonly session?: string,
  ) {
    this.rules = new RuleStore(describeSession(workspace.root).stateDir);
  }

  private say(text: string): void {
    this.tell(SERVICE.notice, { project: this.project, text, approval: true }, this.session);
  }

  async ask(call: ToolRun & { id: string }): Promise<Verdict | Refusal> {
    const path = call.args.path !== undefined ? String(call.args.path) : undefined;
    const what = `${call.id} ${call.tool}${path ? ` ${path}` : ''}`;
    const { rules, error } = await this.rules.load().catch((e: Error) => ({ rules: [] as Rule[], error: e.message }));
    if (error !== this.said) {
      if (error) this.say(`⚠ ${error} — its rules count for nothing until it is fixed: every call is asked`);
      this.said = error;
    }
    const rule = rememberable(call.tool) ? decide(rules, call.tool, path, FOLD) : undefined;
    if (rule) {
      // Answered by a rule: said all the same, and why — what passes stays in sight.
      this.say(`${rule.answer === 'yes' ? '✓' : '✗'} ${what} — ${rule.answer === 'yes' ? 'accepted: always' : 'refused: never'} ${describeRule(rule)} here (${RULES_PATH})`);
      await this.log(call, rule.answer, 'rule', rule);
      return rule.answer === 'yes' ? 'yes' : { verdict: 'no', reason: `the operator said never for ${describeRule(rule)} in this project` };
    }
    const text = (await this.extraPreview(call)) ?? (await preview(this.workspace, call));
    const scopes = rememberable(call.tool) ? scopesFor(call.tool, path) : [];
    // The approval page ticks "remember for this file" for a change: the file one keeps editing.
    const preset = kindOf(call.tool) === 'change' && takesPattern(call.tool) ? 0 : undefined;
    const answer = await this.ask_(
      SERVICE.approve,
      { project: this.project, id: call.id, tool: call.tool, ...(path ? { path } : {}), text, scopes, ...(preset !== undefined ? { preset } : {}) },
      this.session,
    );
    if (!answer) {
      this.out(`  ${this.project}: ${call.id} ${call.tool} refused — nobody answered, in a terminal or in the browser`);
      await this.log(call, 'no', 'nobody');
      return 'no';
    }
    const by = answer.yolo === true ? 'yolo' : answer.browser === true ? 'browser' : 'operator';
    // `always`, from an older client: the widest scope, yes.
    const verdict: Verdict = answer.verdict === 'yes' || answer.verdict === 'always' ? 'yes' : 'no';
    const remember = answer.verdict === 'always' ? (scopes.at(-1)?.pattern ?? true) : answer.remember;
    if ((typeof remember === 'string' || remember === true) && scopes.length > 0) await this.remember(call, path, verdict, remember);
    await this.log(call, verdict, by);
    return verdict;
  }

  /** Keep an answer as a rule — for a pattern that covers this call, or the whole tool when it takes none. */
  private async remember(call: ToolRun & { id: string }, path: string | undefined, answer: Answer, remember: string | true): Promise<void> {
    const pattern = takesPattern(call.tool) ? (typeof remember === 'string' ? remember : '**') : undefined;
    if (pattern !== undefined && (patternProblem(pattern) || !path || !matches(pattern, path, FOLD))) {
      this.say(`not remembered: "${pattern}" is not a pattern covering ${path ?? 'this call'}`);
      return;
    }
    try {
      const rule = await this.rules.add({ tools: kindOf(call.tool), ...(pattern !== undefined ? { pattern } : {}), answer });
      this.say(`remembered: ${answer === 'yes' ? 'always' : 'never'} ${describeRule(rule)} here, in ${RULES_PATH} (/always forget ${describeRule(rule)})`);
    } catch (e) {
      this.say(`not remembered: ${(e as Error).message}`);
    }
  }

  notice(text: string): void {
    this.out(`  ${this.project}: ${text}`);
    this.tell(SERVICE.notice, { project: this.project, text }, this.session);
  }

  async secretValue(request: { id: string; file: string; name: string; description?: string }): Promise<string | undefined> {
    const answer = await this.ask_(SERVICE.secret, { project: this.project, ...request }, this.session);
    return typeof answer?.value === 'string' && answer.value !== '' ? answer.value : undefined;
  }
}

export async function startService(options: ServiceOptions = {}): Promise<Service> {
  const out = options.out ?? ((line: string) => console.log(line));
  const instance = options.instance ?? DEFAULT_INSTANCE;
  const dir = options.dir ?? instanceDir(instance, options.env);
  const saved = await readServiceFile(dir);
  const file: ServiceFile = { ...(saved ?? { id: randomBytes(6).toString('hex'), code: newPairingCode(), operatorKey: randomBytes(24).toString('base64url') }), instance };
  // Asked once for every project: whether octopod answers and its recipes change rarely,
  // and each question is a process.
  const octopod = memoOctopod(options.octopod ?? octopodCli());
  const wait = options.approvalWaitMs ?? APPROVAL_WAIT_MS;

  const sessions: ProjectEntry[] = [];
  // No `daemon` yet: /health names the service only once it answers — its node on the relay,
  // its handlers, its projects back. A client that took the relay listening for the service
  // ready would ask it before it listens, and wait out its timeout.
  const health: SessionHealth & { daemon?: string; instance: string } = { service: 'bushwhack', instance, sessions };
  const { relay, port }: { relay: RelayServer; port: number } = await listenRelay({ ports: options.ports, code: file.code, logDir: join(dir, 'logs'), health: health as unknown as Record<string, unknown> });
  // Standalone (chosen at setup): one server for every project's site.
  const sites = (await readMode(options.env)) === 'standalone' ? await ProjectSites.listen(options.sitePorts) : undefined;
  if (sites) out(`  standalone: the projects' sites on 127.0.0.1:${sites.port} (http://<project>.localhost:${sites.port}/)`);
  await writeServiceFile(dir, { ...file, port, pid: process.pid });

  const node = new HubNode({ nodeId: SERVICE_NODE, defaultScope: 'global' });
  const transport = new WebSocketTransport({
    name: 'relay',
    url: `ws://127.0.0.1:${port}`,
    peerPatterns: ['*'],
    registrationMessage: { type: 'register', nodeId: SERVICE_NODE, securityKey: file.code, client: 'service' },
  });
  node.addTransport(transport);
  await transport.connect();

  // Approvals, one at a time for the whole service: one person answers them all, at the
  // terminal that took them last (two terminals would ask the same question twice) — or, with
  // no terminal taking them, in the browser. One question at a time per place: a project
  // waiting on its operator holds up no other.
  const queues = new Map<string, Promise<unknown>>();
  // The terminals that took the approvals (`--approve-here`, `bushwhack approvals`), in the
  // order they did: the latest still connected gets them — one that closed hands them back
  // to the one before.
  const approvalsAt: string[] = [];
  /**
   * The terminal a project's approvals go to: one taking approvals that follows that
   * project's chat (the one attached last) — so a terminal of another project, `--yolo` or
   * not, never answers for it — else the approvals terminal opened last. None: undefined.
   */
  const approvalsTerminal = (session?: string): string | undefined => {
    const live = new Set(relay.connected().map((c) => c.nodeId));
    const following = [...(session ? (watchers.get(session) ?? []) : [])].filter((n) => n.startsWith(APPROVALS_PREFIX) && live.has(n));
    if (following.length > 0) return following[following.length - 1];
    for (let i = approvalsAt.length - 1; i >= 0; i--) if (live.has(approvalsAt[i])) return approvalsAt[i];
    return undefined;
  };
  /** With no terminal taking approvals: the browser holding the project's chat, else any connected. */
  const approvalsBrowser = (session?: string): string | undefined => {
    const browsers = relay.connected().map((c) => c.nodeId).filter((n) => n.startsWith(EXTENSION_NODE_PREFIX));
    const holder = session ? browserFor(session) : undefined;
    return holder && browsers.includes(holder) ? holder : browsers[browsers.length - 1];
  };
  /** A line for the terminals following a project — those not taking approvals too. */
  const tellFollowers = (session: string | undefined, text: string, except?: string): void => {
    for (const watcher of session ? (watchers.get(session) ?? []) : []) {
      if (watcher !== except) node.emit(SERVICE.notice, { text, approval: true }, { target: watcher });
    }
  };
  const VERDICTS = ['yes', 'no', 'always'];
  /**
   * What each browser was asked and has not answered: asked again when it comes back. A
   * browser reloading its extension loses what it was holding (its notification, its
   * page); the service would otherwise wait for an answer nobody can give any more.
   */
  const askedOf = new Map<string, Set<() => void>>();
  relay.onConnect((nodeId) => {
    // Once the relay has it registered: a message sent sooner would find nobody under that name.
    if (askedOf.has(nodeId)) setTimeout(() => askedOf.get(nodeId)?.forEach((again) => again()), 100);
  });
  /** Ask a browser, and again each time it comes back, until the first answer or the deadline. */
  const askBrowser = (browser: string, kind: string, payload: Record<string, unknown>): Promise<HubEnvelope> =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + wait;
      let settled = false;
      const set = askedOf.get(browser) ?? new Set<() => void>();
      askedOf.set(browser, set);
      const finish = (): void => {
        settled = true;
        clearTimeout(timer);
        set.delete(again);
        if (set.size === 0) askedOf.delete(browser);
      };
      const again = (): void => {
        if (settled) return;
        node.request(kind, payload, { target: browser, timeoutMs: Math.max(1, deadline - Date.now()) }).then(
          (reply) => {
            if (settled) return;
            finish();
            resolve(reply);
          },
          () => undefined,
        );
      };
      const timer = setTimeout(() => {
        if (settled) return;
        finish();
        reject(new Error('nobody answered'));
      }, wait);
      set.add(again);
      again();
    });
  const askOperator = async (kind: string, payload: Record<string, unknown>, session?: string): Promise<Record<string, unknown> | undefined> => {
    const what = `${String(payload.id)} ${String(kind === SERVICE.secret ? 'secret:add' : payload.tool)}`;
    // A secret value is typed in a terminal, never in the browser: it waits for one.
    if (kind === SERVICE.secret && !approvalsTerminal(session)) {
      const text = `⏳ ${what} — a secret value to type: open \`bushwhack --approve-here\` in the project's folder`;
      tellFollowers(session, text);
      const browser = approvalsBrowser(session);
      if (browser) node.emit(SERVICE.notice, { ...payload, text, secret: true }, { target: browser });
      const until = Date.now() + wait;
      while (!approvalsTerminal(session) && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
    }
    const terminal = approvalsTerminal(session);
    const browser = !terminal && kind === SERVICE.approve ? approvalsBrowser(session) : undefined;
    const target = terminal ?? browser ?? `${APPROVALS_PREFIX}*`;
    // The project's other terminals say where it waits: nothing to answer there, but not stuck.
    const where = browser ? 'in the browser' : terminal?.startsWith(APPROVALS_PREFIX) && watchers.get(session ?? '')?.has(terminal) ? 'in its --approve-here terminal' : 'in the bushwhack approvals terminal';
    if (browser || terminal) tellFollowers(session, `⏳ ${what} — waiting for your yes ${where}`, terminal);
    const next = (queues.get(target) ?? Promise.resolve()).then(async () => {
      try {
        const reply = browser ? await askBrowser(browser, kind, payload) : await node.request(kind, payload, { target, timeoutMs: wait });
        const body = reply.payload as Record<string, unknown> | null;
        // Only the operator's own client knows the key; a browser answers only what it was asked.
        if (body && body.key === file.operatorKey && typeof reply.source === 'string' && reply.source.startsWith(APPROVALS_PREFIX)) {
          if (kind === SERVICE.approve) tellFollowers(session, `${body.verdict === 'no' ? '✗' : '✓'} ${what} — ${body.verdict === 'no' ? 'refused' : 'accepted'} ${where}`, terminal);
          return body;
        }
        if (browser && body && reply.source === browser && VERDICTS.includes(String(body.verdict))) {
          tellFollowers(session, `${body.verdict === 'no' ? '✗' : '✓'} ${what} — ${body.verdict === 'no' ? 'refused' : 'accepted'} in the browser`);
          const remember = typeof body.remember === 'string' || body.remember === true ? { remember: body.remember } : {};
          return { verdict: body.verdict, ...remember, browser: true };
        }
        return undefined;
      } catch {
        return undefined;
      }
    });
    queues.set(target, next.catch(() => undefined));
    // Answered or not, the browser's notification and page for it have had their day.
    if (browser) void next.then(() => node.emit(APPROVAL.done, { project: payload.project, id: payload.id }, { target: browser }));
    return next;
  };

  /** A line for the operator — at the terminal taking approvals, and at those following the project. */
  const tellOperator = (kind: string, payload: Record<string, unknown>, session?: string): void => {
    const terminal = approvalsTerminal(session);
    if (terminal) node.emit(kind, payload, { target: terminal });
    for (const watcher of session ? (watchers.get(session) ?? []) : []) if (watcher !== terminal) node.emit(kind, payload, { target: watcher });
  };

  const open = new Map<string, OpenSession>();
  /** Each project's approver, by node: its "always" rules, shown and forgotten on demand. */
  const approvers = new Map<string, RemoteApprover>();
  const projectsFile = join(dir, 'projects.json');
  // Not while the saved list is being brought back: a crash then would lose the rest of it.
  let restoring = false;
  const saveProjects = async (): Promise<void> => {
    if (!restoring) await writeFile(projectsFile, JSON.stringify([...open.keys()], null, 2) + '\n', { mode: 0o600 });
  };

  /**
   * A folder is active in one instance at a time: the one named in its `.bushwhack/`
   * marker, as long as that instance answers for it.
   */
  const activeElsewhere = async (root: string): Promise<string | undefined> => {
    const marker = await readFile(join(root, '.bushwhack', 'instance.json'), 'utf8').then((t) => JSON.parse(t) as { id: string; instance: string; port: number }, () => undefined);
    if (!marker || marker.id === file.id) return undefined;
    try {
      const response = await fetch(`http://127.0.0.1:${marker.port}/health`, { signal: AbortSignal.timeout(500) });
      const other = (await response.json()) as { daemon?: string; sessions?: { folder: string }[] };
      return other.daemon === marker.id && (other.sessions ?? []).some((s) => s.folder === root) ? marker.instance : undefined;
    } catch {
      return undefined;
    }
  };

  /** A project's app address, as /health and the list show it. */
  const setUrl = (nodeId: string, urls: string[]): void => {
    const entry = sessions.find((s) => s.nodeId === nodeId);
    if (!entry) return;
    if (urls[0]) entry.url = urls[0];
    else delete entry.url;
  };

  const add = async (folder: string): Promise<ProjectEntry> => {
    const root = resolve(folder);
    const existing = sessions.find((s) => s.folder === root);
    if (existing) return existing;
    const other = await activeElsewhere(root);
    if (other) throw new Error(`${root} is active in the "${other}" instance — bushwhack --instance ${other} remove there first`);
    const session = await openSession({
      folder: root,
      relay: { port, code: file.code },
      browser: () => browserFor(describeSession(root).nodeId),
      approver: (workspace, extra) => {
        const who = describeSession(workspace.root);
        const approver = new RemoteApprover(askOperator, who.name, workspace, extra as never, out, tellOperator, who.nodeId);
        approvers.set(who.nodeId, approver);
        return approver;
      },
      octopod,
      env: options.env,
      out,
      sites,
      onApp: (urls) => setUrl(describeSession(root).nodeId, urls),
    });
    open.set(session.session.folder, session);
    await writeFile(join(session.session.stateDir, 'instance.json'), JSON.stringify({ id: file.id, instance, port }) + '\n');
    const entry = { session: session.session.name, folder: session.session.folder, nodeId: session.session.nodeId, app: session.appLine };
    sessions.push(entry);
    // Asked of octopod in the background: a slow docker must not hold the project back.
    void session.appUrls().then((urls) => setUrl(entry.nodeId, urls));
    await saveProjects();
    out(`+ ${entry.session}  ${entry.folder}`);
    return entry;
  };

  const remove = async (folder: string): Promise<boolean> => {
    const root = resolve(folder);
    const session = open.get(root);
    if (!session) return false;
    session.close();
    open.delete(root);
    await rm(join(session.session.stateDir, 'instance.json'), { force: true });
    sessions.splice(sessions.findIndex((s) => s.folder === root), 1);
    await saveProjects();
    out(`- ${session.session.name}  ${root}`);
    return true;
  };

  // The CLI's requests: only with the operator key.
  const reply = (envelope: HubEnvelope, payload: unknown): void => {
    node.emit(SERVICE.reply, payload, { target: envelope.source, replyToId: envelope.id });
  };
  const operator = (payload: unknown): payload is { key: string; folder?: string } =>
    !!payload && typeof payload === 'object' && (payload as { key?: unknown }).key === file.operatorKey;
  node.on(SERVICE.approvalsHere, (payload: unknown, envelope) => {
    if (!operator(payload) || !envelope.source.startsWith(APPROVALS_PREFIX)) return reply(envelope, { error: 'not the operator' });
    approvalsAt.splice(0, approvalsAt.length, ...approvalsAt.filter((n) => n !== envelope.source), envelope.source);
    reply(envelope, { ok: true });
    tellTerminals();
  });
  // The terminal chat. Terminals attach to a project; the extension's reports about that
  // project reach them. Sending a prompt acts in the operator's name at the chat provider:
  // only for the operator's key, and only the service asks the extension.
  const watchers = new Map<string, Set<string>>();
  /** What each terminal said of itself when it attached (its pid, its tty), and since when. */
  const terminalInfo = new Map<string, { label?: string; since: number }>();
  // Which browser has which project's chat open, and when it last said so: with several
  // browsers on one service, a prompt goes to the one holding the chat.
  const presence = new Map<string, Map<string, { at: number; conversation?: string; chat?: string }>>();
  // A hidden tab's timers run about once a minute: its announcements come that seldom.
  // A departure is announced (`left`); this only drops a browser that went silent.
  const PRESENCE_MS = options.presenceMs ?? 90_000;
  /** How long a terminal that opens waits for the browsers to say which chats they show. */
  const WHO_WAIT_MS = 800;
  const WHO_EVERY_MS = 10_000;
  /** The chat each project's terminals were last told of: they hear of a change, not of every return. */
  const told = new Map<string, LiveChat | undefined>();
  const chatOf = (session: string): LiveChat | undefined => {
    const seen = [...(presence.get(session) ?? new Map())].filter(([, p]) => Date.now() - p.at < PRESENCE_MS);
    const [browser, p] = seen.sort((a, b) => b[1].at - a[1].at)[0] ?? [];
    return browser ? { browser, ...(p.chat ? { chat: p.chat } : {}), ...(p.conversation ? { conversation: p.conversation } : {}) } : undefined;
  };
  const browserName = (node: string): string => relay.connected().find((c) => c.nodeId === node)?.fingerprint ?? 'a browser';
  /** Tell the terminals following a project which chat its prompts now go to — or that none holds it now. */
  const tell = (session: string, text: string | undefined): void => {
    for (const watcher of watchers.get(session) ?? []) node.emit(CHAT.event, { session, kind: 'chat', ...(text ? { text } : {}) } satisfies ChatEvent, { target: watcher });
  };
  const browserFor = (session: string): string | undefined => chatOf(session)?.browser;
  /** The terminals following a project's chat, and where its approvals go: what its chat page shows. */
  const terminalsOf = (session: string): ChatTerminals => {
    const live = new Set(relay.connected().map((c) => c.nodeId));
    const following = [...(watchers.get(session) ?? [])].filter((n) => /^(approvals|chat):/.test(n) && live.has(n));
    const terminal = approvalsTerminal(session);
    const list = following.map((id) => ({ id, approves: id === terminal, ...(terminalInfo.get(id)?.label ? { label: terminalInfo.get(id)!.label } : {}), since: terminalInfo.get(id)?.since ?? 0 }));
    return { session, terminals: following.length, approvals: terminal ? (following.includes(terminal) ? 'here' : 'terminal') : 'browser', list };
  };
  /** Tell the browsers, now: a terminal came, went, or took the approvals. */
  const tellTerminals = (only?: string, to = `${EXTENSION_NODE_PREFIX}*`): void => {
    for (const s of sessions) if (!only || s.nodeId === only) node.emit(CHAT.terminals, terminalsOf(s.nodeId), { target: to });
  };
  // A terminal that leaves: its project's page stops showing it. (The relay drops it first.)
  relay.onDisconnect((nodeId) => {
    if (!nodeId.startsWith(EXTENSION_NODE_PREFIX)) setTimeout(() => tellTerminals(), 50);
  });
  // A browser that comes: its panel shows every project's terminals from the start.
  relay.onConnect((nodeId) => {
    if (nodeId.startsWith(EXTENSION_NODE_PREFIX)) setTimeout(() => tellTerminals(undefined, nodeId), 100);
  });
  // Closing a terminal from a browser's panel (confirmed there): only one following a project
  // of this service. It leaves, and says who closed it.
  node.on(CHAT.closeTerminal, (payload: unknown, envelope) => {
    const p = (payload ?? {}) as { session?: unknown; terminal?: unknown };
    const answer = (body: Record<string, unknown>): void => {
      node.emit(CHAT.reply, body, { target: envelope.source, replyToId: envelope.id });
    };
    if (!envelope.source.startsWith(EXTENSION_NODE_PREFIX) || typeof p.session !== 'string' || typeof p.terminal !== 'string') return answer({ error: 'malformed' });
    if (!/^(approvals|chat):/.test(p.terminal) || !watchers.get(p.session)?.has(p.terminal)) return answer({ error: 'no such terminal on this project' });
    node.emit(SERVICE.close, { by: browserName(envelope.source) }, { target: p.terminal });
    out(`  a terminal of ${sessions.find((s) => s.nodeId === p.session)?.session ?? p.session} closed from ${browserName(envelope.source)}`);
    answer({ ok: true });
  });
  /**
   * Before saying which chats are open: when one of these projects' is not known to be, ask
   * the connected browsers now (chat:who) and give them a moment to say — a hidden tab's
   * heartbeat comes about once a minute. Asked once every few seconds at most.
   */
  let askedAt = 0;
  const askBrowsers = async (projects: string[]): Promise<void> => {
    const unknown = (): boolean => projects.some((p) => !chatOf(p));
    if (!unknown() || Date.now() - askedAt < WHO_EVERY_MS) return;
    if (!relay.connected().some((c) => c.nodeId.startsWith(EXTENSION_NODE_PREFIX))) return;
    askedAt = Date.now();
    node.emit(CHAT.who, {}, { target: `${EXTENSION_NODE_PREFIX}*` });
    const until = Date.now() + WHO_WAIT_MS;
    while (unknown() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  };
  node.on(CHAT.here, (payload: unknown, envelope) => {
    const { session, conversation, chat, left } = (payload ?? {}) as { session?: unknown; conversation?: unknown; chat?: unknown; left?: unknown };
    if (!envelope.source.startsWith(EXTENSION_NODE_PREFIX) || typeof session !== 'string') return;
    // The page learns which terminals follow its chat — a page just opened too.
    if (left !== true && sessions.some((s) => s.nodeId === session)) node.emit(CHAT.terminals, terminalsOf(session), { target: envelope.source });
    const before = chatOf(session);
    // This browser no longer shows the project's chat (navigated away, tab closed).
    if (left === true) {
      presence.get(session)?.delete(envelope.source);
      const after = chatOf(session);
      if (before && !after) tell(session, undefined);
      else if (after && before?.browser !== after.browser) tell(session, describeChat({ ...after, browser: browserName(after.browser) }));
      told.set(session, after);
      return;
    }
    const map = presence.get(session) ?? new Map<string, { at: number; conversation?: string; chat?: string }>();
    map.set(envelope.source, { at: Date.now(), ...(typeof conversation === 'string' ? { conversation } : {}), ...(typeof chat === 'string' ? { chat } : {}) });
    presence.set(session, map);
    // Another chat, browser or conversation than before: the terminals say where prompts go
    // now. A new chat getting its id at its first message is the same chat. A chat back after
    // going silent is news too: the terminals opened meanwhile were told there was none.
    const after = chatOf(session)!;
    const last = before ? told.get(session) : undefined;
    const moved = !last || last.browser !== after.browser || last.chat !== after.chat || (last.conversation !== undefined && last.conversation !== after.conversation);
    if (moved) tell(session, describeChat({ ...after, browser: browserName(after.browser) }));
    told.set(session, after);
  });
  node.on(SERVICE.chatAttach, (payload: unknown, envelope) => {
    if (!operator(payload) || typeof (payload as { session?: unknown }).session !== 'string') return reply(envelope, { error: 'not the operator, or no session' });
    const session = (payload as unknown as { session: string }).session;
    if (!sessions.some((s) => s.nodeId === session)) return reply(envelope, { error: 'no such project' });
    const set = watchers.get(session) ?? new Set<string>();
    const label = (payload as { label?: unknown }).label;
    if (!terminalInfo.has(envelope.source)) terminalInfo.set(envelope.source, { since: Date.now(), ...(typeof label === 'string' ? { label: label.slice(0, 80) } : {}) });
    set.add(envelope.source);
    watchers.set(session, set);
    tellTerminals(session);
    // The terminal starts knowing where its prompts go.
    void askBrowsers([session]).then(() => reply(envelope, { ok: true }));
  });
  node.on(SERVICE.chatSend, async (payload: unknown, envelope) => {
    const p = payload as { session?: unknown; text?: unknown; manifest?: unknown; shell?: unknown };
    const manifest = p.manifest === true;
    if (!operator(payload) || typeof p.session !== 'string' || typeof p.text !== 'string' || (!manifest && p.text.trim() === '')) return reply(envelope, { error: 'not the operator, or nothing to send' });
    if (!sessions.some((s) => s.nodeId === p.session)) return reply(envelope, { error: 'no such project' });
    const browser = browserFor(p.session);
    if (!browser) return reply(envelope, { error: 'no browser has a chat of this project open — open one bound to it (the bushwhack panel binds it)' });
    // A shell command's output (`!command` in a terminal): masked like any result — a
    // declared secret never reaches the chat, even printed by the operator's own command.
    let text = p.text;
    if (p.shell === true) {
      const folder = sessions.find((x) => x.nodeId === p.session)?.folder;
      const project = folder ? open.get(folder) : undefined;
      if (!project) return reply(envelope, { error: 'no such project' });
      text = (await project.mask())(text);
    }
    node
      .request(CHAT.send, { session: p.session, text, ...(manifest ? { manifest } : {}) }, { target: browser, timeoutMs: 60_000 })
      .then((r) => reply(envelope, r.payload), () => reply(envelope, { error: 'no browser answered — is the extension connected (pair it, and open the project\'s chat)?' }));
  });
  node.on(CHAT.event, (payload: unknown, envelope) => {
    if (!envelope.source.startsWith(EXTENSION_NODE_PREFIX)) return;
    const event = payload as ChatEvent;
    for (const watcher of watchers.get(event?.session) ?? []) node.emit(CHAT.event, event, { target: watcher });
  });

  // The "always" rules, per project; forgotten on demand (`forget`: a tool, or true for all).
  node.on(SERVICE.always, async (payload: unknown, envelope) => {
    if (!operator(payload)) return reply(envelope, { error: 'not the operator' });
    const p = payload as { session?: unknown; forget?: unknown };
    type Listed = { project: string; rule: string; answer: Answer };
    const forgotten: Listed[] = [];
    const rules: Listed[] = [];
    const errors: { project: string; error: string }[] = [];
    for (const s of sessions) {
      const approver = approvers.get(s.nodeId);
      if (!approver || (typeof p.session === 'string' && p.session !== s.nodeId)) continue;
      try {
        if (p.forget === true || typeof p.forget === 'string') {
          for (const r of await approver.rules.forget(typeof p.forget === 'string' ? p.forget : undefined)) forgotten.push({ project: s.session, rule: describeRule(r), answer: r.answer });
        }
        const { rules: kept, error } = await approver.rules.load();
        if (error) errors.push({ project: s.session, error });
        for (const r of kept) rules.push({ project: s.session, rule: describeRule(r), answer: r.answer });
      } catch (e) {
        errors.push({ project: s.session, error: (e as Error).message });
      }
    }
    reply(envelope, { rules, forgotten, errors });
  });

  node.on(SERVICE.list, async (payload: unknown, envelope) => {
    if (!operator(payload)) return reply(envelope, { error: 'not the operator' });
    await askBrowsers(sessions.map((s) => s.nodeId));
    // Which browsers are connected, and which projects' chats each has open: where prompts go.
    const connected = relay.connected().filter((c) => c.nodeId.startsWith(EXTENSION_NODE_PREFIX));
    const browsers = connected
      .map((c) => ({
        node: c.nodeId,
        browser: c.fingerprint ?? 'a browser',
        dev: c.type === 'extension-dev',
        chats: sessions.filter((s) => browserFor(s.nodeId) === c.nodeId).map((s) => s.session),
      }));
    // Each project, and the chat it is live in — the browser named as the terminal names it.
    const projects = sessions.map((s) => {
      const chat = chatOf(s.nodeId);
      return chat ? { ...s, chat: { ...chat, browser: browserName(chat.browser) } } : s;
    });
    reply(envelope, { projects, code: file.code, port, instance, browsers });
  });
  node.on(SERVICE.add, (payload: unknown, envelope) => {
    if (!operator(payload) || typeof payload.folder !== 'string') return reply(envelope, { error: 'not the operator, or no folder' });
    add(payload.folder).then((entry) => reply(envelope, { project: entry, code: file.code }), (e: Error) => reply(envelope, { error: e.message }));
  });
  node.on(SERVICE.remove, (payload: unknown, envelope) => {
    if (!operator(payload) || typeof payload.folder !== 'string') return reply(envelope, { error: 'not the operator, or no folder' });
    remove(payload.folder).then((removed) => reply(envelope, { removed }), (e: Error) => reply(envelope, { error: e.message }));
  });

  // Projects added before: back, each on its own, a missing folder left out and said.
  let previous: string[] = [];
  try {
    previous = JSON.parse(await readFile(projectsFile, 'utf8')) as string[];
  } catch {
    // none yet
  }
  restoring = true;
  for (const folder of previous) {
    await add(folder).catch((e: Error) => out(`! ${folder}: ${e.message}`));
  }
  restoring = false;
  health.daemon = file.id;

  out(`bushwhack service "${instance}" on ws://127.0.0.1:${port} — ${sessions.length} project${sessions.length === 1 ? '' : 's'}`);
  return {
    id: file.id,
    port,
    code: file.code,
    add,
    remove,
    list: () => [...sessions],
    async close() {
      for (const s of open.values()) s.close();
      await sites?.close();
      transport.disconnect();
      await relay.close();
    },
  };
}
