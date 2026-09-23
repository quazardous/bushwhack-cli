/**
 * One session: a project folder as a chat sees it — its workspace jail, its tools, its
 * replay store, its app — behind one hub node on a relay. `bushwhack serve` runs one of
 * them next to its own relay; the service runs one per project, all on one relay. Nothing
 * is shared between two sessions but the process.
 */
import { join } from 'node:path';
import { HubNode, WebSocketTransport, type HubEnvelope } from '@bushwhack/hub';
import {
  BRIDGE,
  CHAT_PROMPT_LIMITS,
  formatResults,
  renderManifest,
  type ChatPrompt,
  type Picture,
  type Result,
  type ToolsCallReply,
  type ToolsCallRequest,
  type ToolsListReply,
} from '@bushwhack/protocol';
import { FS_TOOLS, runFsTool, Workspace } from '@bushwhack/workspace';
import { PAGE_ACT, PAGE_TOOLS } from '@bushwhack/page/daemon';
import { IGNORE_TOOLS, runIgnoreTool } from './ignores.js';
import { REPORT_TOOLS, runReportTool } from './reports.js';
import { IMAGE_TOOLS, runImageTool } from './images.js';
import { runSecretTool, SECRET_TOOLS } from './secrets.js';
import { VERSION } from './version.js';
import { AppHost, appTools, databasesOf, stacksOf } from './app.js';
import { originsOf, PAGE_TIMEOUT_MS, PageHost } from './page.js';
import type { OctopodCheck, OctopodClient } from './octopod-client.js';
import { Dispatcher, type Approver, type ToolHost } from './dispatcher.js';
import { describeSession, ensureStateDir, type SessionInfo } from './session.js';
import { CallStore } from './store.js';
import type { ProjectSites } from './site.js';
import type { ToolSpec } from '@bushwhack/protocol';

/** One request may carry this many calls; a turn holding more is a runaway, not a plan. */
const MAX_CALLS_PER_REQUEST = 20;

/** A chat prompt from a client, bounded like the driver schema bounds it; anything else is dropped. */
function chatPromptOf(payload: unknown): ChatPrompt | undefined {
  const chat = (payload as { chat?: unknown } | null)?.chat;
  if (!chat || typeof chat !== 'object') return undefined;
  const { title, preamble, notes } = chat as Record<string, unknown>;
  const L = CHAT_PROMPT_LIMITS;
  if (typeof title !== 'string' || title.length === 0 || title.length > L.title) return undefined;
  if (typeof preamble !== 'string' || preamble.length === 0 || preamble.length > L.preamble) return undefined;
  if (!Array.isArray(notes) || notes.length > L.notes) return undefined;
  if (!notes.every((n): n is string => typeof n === 'string' && n.length > 0 && n.length <= L.note)) return undefined;
  return { title, preamble, notes };
}

/** A replayed screenshot: the picture went with the first answer and was not kept. */
function replayedPicture(result: Result): Result {
  return { ...result, content: 'this call already ran, and its picture went with that first answer — a new page:screenshot takes a new one' };
}

function isCallRequest(payload: unknown): payload is ToolsCallRequest {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.conversation === 'string' &&
    p.conversation.length > 0 &&
    p.conversation.length <= 200 &&
    Array.isArray(p.calls) &&
    p.calls.every((c) => typeof c === 'string') &&
    (p.pictures === undefined ||
      (Array.isArray(p.pictures) &&
        p.pictures.length <= 8 &&
        p.pictures.every((x) => !!x && typeof x === 'object' && typeof (x as { dataUrl?: unknown }).dataUrl === 'string')))
  );
}

export interface SessionOptions {
  folder: string;
  /** The relay the session's node registers on, and the code it registers with. */
  relay: { port: number; code: string };
  /** Who says yes or no — given the session's workspace and, for app:create, its preview. */
  approver: (workspace: Workspace, preview: (call: { tool: string; args: Record<string, unknown> }) => Promise<string> | undefined) => Approver;
  octopod: OctopodClient;
  env?: NodeJS.ProcessEnv;
  out: (line: string) => void;
  /** The browser holding this project's chat, when known: where a page:* call from the CLI goes. */
  browser?: () => string | undefined;
  /** The app's addresses changed: created, restarted, destroyed. */
  onApp?: (urls: string[]) => void;
  /**
   * Standalone mode (chosen at setup): the project's files served as they are, instead of
   * an app through octopod — which is then not asked at all.
   */
  sites?: ProjectSites;
}

/**
 * page:* in standalone mode: the same tools, and what the model is told the site is — its
 * files as they are, nothing running them on the machine — so it builds what can work there.
 */
export function siteTools(url: string): ToolSpec[] {
  return PAGE_TOOLS.map((spec) =>
    spec.name !== 'page:open'
      ? spec
      : {
          ...spec,
          notes: [
            `The app is the project's files as they are, served at ${url} — a path is a file of the project (a folder serves its index.html). Nothing runs them on the machine: no npm run dev, no build, no server code, no database server. There are no app:* tools.`,
            'Build what works in the browser alone: HTML, CSS and JavaScript (ES modules; a library as a file of the project, or from a CDN). Keep data in the page — localStorage or IndexedDB, or SQLite in the page through WebAssembly (sql.js or wa-sqlite, its .wasm a file of the project), a starting .db file loaded with fetch.',
            'After writing a file, page:open again to load it: the site sends every file fresh.',
            ...(spec.notes ?? []),
          ],
        },
  );
}

export interface OpenSession {
  session: SessionInfo;
  workspace: Workspace;
  /** One line on the app: its stacks and URL, or why there is none. */
  appLine: string;
  /** The addresses the app is served at; none without an app. */
  appUrls(): Promise<string[]>;
  close(): void;
}

/** A folder's session info and state directory, before anything connects. */
export async function prepareSession(folder: string, env?: NodeJS.ProcessEnv): Promise<{ workspace: Workspace; session: SessionInfo }> {
  const workspace = await Workspace.open(folder);
  const session = describeSession(workspace.root);
  await ensureStateDir(session, env);
  return { workspace, session };
}

export async function openSession(options: SessionOptions): Promise<OpenSession> {
  const { out, octopod } = options;
  const { workspace, session } = await prepareSession(options.folder, options.env);
  const store = await CallStore.open(join(session.stateDir, 'calls.jsonl'));

  // Standalone: the project's own site, and octopod left alone. Otherwise the web app, when
  // octopod (and so docker) is there to run it: its app recipes are the stacks.
  const siteUrl = options.sites?.add(session.name, workspace);
  const checked: OctopodCheck = siteUrl
    ? { ok: false, why: 'standalone' }
    : octopod.check
      ? await octopod.check()
      : (await octopod.available())
        ? { ok: true, version: '?' }
        : { ok: false, why: 'octopod not found or not answering' };
  const recipes = checked.ok ? await octopod.recipes().catch(() => []) : [];
  const stacks = stacksOf(recipes);
  const databases = databasesOf(recipes);
  const app = stacks.length > 0 ? new AppHost(session, octopod, databases) : undefined;
  const approver = options.approver(workspace, (call) => (call.tool === 'app:create' && app ? app.preview(call.args as never) : undefined));
  const tools = [...FS_TOOLS, ...IGNORE_TOOLS, ...SECRET_TOOLS, ...IMAGE_TOOLS, ...REPORT_TOOLS, ...(siteUrl ? siteTools(siteUrl) : app ? [...appTools(stacks, databases), ...PAGE_TOOLS] : [])];

  const node = new HubNode({ nodeId: session.nodeId, defaultScope: 'global' });
  const appUrls = async (): Promise<string[]> => (siteUrl ? [siteUrl] : app ? app.urls() : []);
  const page = siteUrl || app
    ? new PageHost(session, async () => originsOf(await appUrls()), async (target, request) =>
        (await node.request(PAGE_ACT, request, { target: target.endsWith('*') ? (options.browser?.() ?? target) : target, timeoutMs: PAGE_TIMEOUT_MS })).payload,
      )
    : undefined;
  /** What the chat must not see in any result: declared secret values, and the app's credentials. */
  const redactor = async (): Promise<(text: string) => string> => {
    const secrets = await workspace.secrets.redactor();
    const credentials = app ? await app.mask() : (text: string) => text;
    return (text) => credentials(secrets(text));
  };
  let pictures: Picture[] = [];
  const host: ToolHost = {
    specs: tools,
    run: (call) =>
      call.tool.startsWith('secret:')
        ? runSecretTool(workspace, approver, call)
        : call.tool.startsWith('ignore:')
          ? runIgnoreTool(workspace, call)
        : call.tool === 'image:save'
          ? runImageTool(workspace, pictures, call)
        : call.tool === 'report:bug'
          ? redactor().then((mask) =>
              runReportTool({ stateDir: session.stateDir, store, version: VERSION, mask, notice: (text) => (approver.notice ? approver.notice(text) : out(text)) }, call),
            )
        : call.tool.startsWith('app:') && app
          ? app.run(call).finally(() => {
              if (['app:create', 'app:restart', 'app:destroy'].includes(call.tool)) void app.urls().then((urls) => options.onApp?.(urls), () => undefined);
            })
          : call.tool.startsWith('page:') && page
            ? page.run(call)
            : runFsTool(workspace, call.tool, call.args, call.body),
    redactor,
  };
  const appLine = siteUrl
    ? `standalone: the project's files as they are, at ${siteUrl} (nothing run on the machine)`
    : app
    ? `${stacks.join(', ')} through octopod — http://${session.name}.localhost`
    : `unavailable — ${checked.ok ? `octopod ${checked.version} has no app recipe` : checked.why}: fs and secret tools only`;
  const dispatcher = new Dispatcher(host, store, approver, (line) => out(`  ${line}`));

  const transport = new WebSocketTransport({
    name: 'relay',
    url: `ws://127.0.0.1:${options.relay.port}`,
    peerPatterns: ['*'],
    registrationMessage: { type: 'register', nodeId: session.nodeId, securityKey: options.relay.code, client: 'daemon' },
  });
  node.addTransport(transport);
  await transport.connect();

  const reply = (envelope: HubEnvelope, payload: unknown): void => {
    node.emit(BRIDGE.reply, payload, { target: envelope.source, replyToId: envelope.id });
  };

  node.on(BRIDGE.list, (payload: unknown, envelope) => {
    if (envelope.source === session.nodeId) return;
    const manifest = renderManifest(tools, { session: session.name, chat: chatPromptOf(payload) });
    const answer: ToolsListReply = { manifest, tools: tools.map((t) => t.name) };
    reply(envelope, answer);
  });

  // Requests run one after another, whoever sent them: approvals are asked in order, and
  // two clients cannot interleave writes to the same file.
  let queue: Promise<unknown> = Promise.resolve();
  node.on(BRIDGE.call, (payload: unknown, envelope) => {
    if (envelope.source === session.nodeId) return;
    if (!isCallRequest(payload)) {
      reply(envelope, { error: 'malformed tools:call request' });
      return;
    }
    if (payload.calls.length === 0 || payload.calls.length > MAX_CALLS_PER_REQUEST) {
      reply(envelope, { error: `a request carries 1 to ${MAX_CALLS_PER_REQUEST} calls` });
      return;
    }
    queue = queue.then(async () => {
      out(`← ${session.name}: ${payload.calls.length} call${payload.calls.length > 1 ? 's' : ''} from ${payload.conversation}`);
      const done = [];
      // The pictures of this request, for its image:save calls: requests run one at a time.
      pictures = payload.pictures ?? [];
      // In order; once the operator says no, the rest of the answer is not run: it may depend
      // on the refused step, and would only ask more questions nobody wants.
      let refused: string | undefined;
      for (const text of payload.calls) {
        if (refused) {
          done.push(dispatcher.skip(text, refused));
          continue;
        }
        const d = await dispatcher.dispatch(payload.conversation, text, envelope.source);
        done.push(d);
        if (d.result.status === 'denied') refused = d.result.id ?? 'a call';
      }
      const images = done.flatMap((d) => (d.image ? [{ id: d.result.id, image: d.image }] : []));
      const answer: ToolsCallReply = {
        text: formatResults(done.map((d) => (d.replay && d.result.meta?.image ? replayedPicture(d.result) : d.result))),
        summary: done.map((d) => ({
          id: d.result.id,
          tool: d.result.tool,
          status: d.result.status,
          replay: d.replay,
          // The operator sees why at once — an invalid call especially, which nothing else records.
          ...(d.result.status === 'error' && d.result.content ? { error: shortError(d.result.content) } : {}),
        })),
        ...(images.length > 0 ? { images } : {}),
      };
      reply(envelope, answer);
    }).catch((e: unknown) => {
      out(`! ${(e as Error).message}`);
      reply(envelope, { error: 'the daemon failed on this request; see its terminal' });
    });
  });

  return {
    session,
    workspace,
    appLine,
    appUrls: () => appUrls().catch(() => []),
    close() {
      options.sites?.remove(session.name);
      transport.disconnect();
    },
  };
}

/** An error's first line, cut to fit a terminal line. */
export function shortError(content: string): string {
  const line = content.trim().split('\n')[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
