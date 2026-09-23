/**
 * From call text to result: the one path every call takes, whoever sent it.
 *
 *   text ──scanCall──► call ──bindArgs──► typed ──store──► new? ──approve──► run ──► record
 *
 * The daemon trusts nothing the page sends: it re-parses the raw block text itself. What
 * the extension decided is only which blocks to send.
 */
import { ArgsError, bindArgs, scanCall, type Args, type Result, type ToolSpec } from '@bushwhack/protocol';
import { hashCall, type CallStore } from './store.js';

export interface ToolRun {
  tool: string;
  args: Args;
  body: string | null;
}

/** What a tool returns. An image travels beside the result, never in the replay store. */
export type ToolOutcome = Omit<Result, 'tool' | 'id'> & { image?: string };

export interface ToolHost {
  specs: ToolSpec[];
  /** `from` is the hub node that sent the request: where page:* calls go back to. */
  run(call: ToolRun & { id: string; conversation: string; from: string }): Promise<ToolOutcome>;
  /**
   * Masks what must never reach the chat (declared secret values) in a result about to be
   * sent. Applied to every result, before it is recorded as well: the replay store holds
   * nothing the chat could not see.
   */
  redactor?(): Promise<(text: string) => string>;
}

export type Verdict = 'yes' | 'no';

export interface Approver {
  /** Called only for tools whose spec says `approval: true`. */
  ask(call: ToolRun & { id: string; conversation: string }): Promise<Verdict>;
  /** A secret's value, typed by the operator — undefined when they refuse. Never shown anywhere. */
  secretValue(request: { id: string; file: string; name: string; description?: string }): Promise<string | undefined>;
  /** A line for the operator, now — nothing to answer (a report:bug). */
  notice?(text: string): void;
}

export interface Dispatched {
  result: Result;
  replay: boolean;
  /** A data: URL to send with the result; only on the run that produced it. */
  image?: string;
}

export class Dispatcher {
  private readonly specs: Map<string, ToolSpec>;

  constructor(
    private readonly host: ToolHost,
    private readonly store: CallStore,
    private readonly approver: Approver,
    private readonly onEvent: (line: string) => void = () => {},
  ) {
    this.specs = new Map(host.specs.map((spec) => [spec.name, spec]));
  }

  async dispatch(conversation: string, text: string, from = ''): Promise<Dispatched> {
    const scanned = scanCall(text);
    if (!scanned) return this.fail(null, 'unknown', 'not a bushwhack call');
    if (scanned.kind === 'incomplete') {
      return this.fail(
        /^id:\s*(\S+)/m.exec(text)?.[1] ?? null,
        'unknown',
        'this call has no ---end line — its block ended early. If its body holds a line of three backticks, fence the call with four or more',
      );
    }
    if (scanned.kind === 'invalid') return this.fail(scanned.id, 'unknown', scanned.error);

    const { call } = scanned;
    const spec = this.specs.get(call.tool);
    if (!spec) {
      return this.fail(call.id, call.tool, `no tool "${call.tool}"; the tools are ${[...this.specs.keys()].join(', ')}`);
    }

    const hash = hashCall(text);
    const seen = this.store.lookup(conversation, call.id, hash);
    if (seen.kind === 'replay') return { result: seen.result, replay: true };
    if (seen.kind === 'conflict') {
      // Not recorded: the id stays bound to the call it first named.
      return this.fail(call.id, call.tool, `id "${call.id}" was already used in this conversation for another call; use a new id`);
    }

    let bound;
    try {
      bound = bindArgs(spec, call.args, call.body);
    } catch (e) {
      if (!(e instanceof ArgsError)) throw e;
      return this.settle(conversation, call.id, hash, { tool: call.tool, id: call.id, status: 'error', content: e.message });
    }

    const run: ToolRun = { tool: call.tool, args: bound.args, body: bound.body };
    if (spec.approval && (await this.approver.ask({ ...run, id: call.id, conversation })) === 'no') {
      return this.settle(conversation, call.id, hash, {
        tool: call.tool,
        id: call.id,
        status: 'denied',
        content: 'the operator refused this call',
      });
    }

    const { image, ...outcome } = await this.host.run({ ...run, id: call.id, conversation, from });
    const settled = await this.settle(conversation, call.id, hash, { tool: call.tool, id: call.id, ...outcome });
    return image ? { ...settled, image } : settled;
  }

  private async redact(result: Result): Promise<Result> {
    if (!this.host.redactor) return result;
    const mask = await this.host.redactor();
    const meta = result.meta
      ? Object.fromEntries(Object.entries(result.meta).map(([k, v]) => [k, typeof v === 'string' ? mask(v) : v]))
      : undefined;
    return { ...result, ...(meta ? { meta } : {}), ...(result.content !== undefined ? { content: mask(result.content) } : {}) };
  }

  private async settle(conversation: string, id: string, hash: string, raw: Result): Promise<Dispatched> {
    const result = await this.redact(raw);
    await this.store.record(conversation, id, hash, result);
    this.onEvent(`${result.status === 'ok' ? '✓' : result.status === 'denied' ? '✗' : '!'} ${id} ${result.tool} ${result.status}`);
    return { result, replay: false };
  }

  /**
   * A call not run: one before it in the same answer was denied, and what follows a refused
   * step may depend on it. Not recorded — sent again later, it runs.
   */
  skip(text: string, refused: string): Dispatched {
    const scanned = scanCall(text);
    const id = scanned?.kind === 'call' ? scanned.call.id : scanned?.kind === 'invalid' ? scanned.id : null;
    const tool = scanned?.kind === 'call' ? scanned.call.tool : 'unknown';
    this.onEvent(`- ${id ?? '?'} ${tool} skipped`);
    return { result: { tool, id, status: 'skipped', content: `not run: ${refused} was denied just before it, and this call may have depended on it — send it again in a new answer if it still makes sense` }, replay: false };
  }

  private fail(id: string | null, tool: string, error: string): Dispatched {
    this.onEvent(`! ${id ?? '?'} ${tool} ${error}`);
    return { result: { tool, id, status: 'error', content: error }, replay: false };
  }
}
