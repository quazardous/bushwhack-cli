/**
 * The terminal prompt. A speed bump, not the boundary — the jail is the boundary — but a
 * speed bump that shows what is about to happen: the path, and for a write, what changes.
 *
 * One question at a time, in call order. `a` approves that tool for the rest of the
 * session; it is the operator's shortcut and the prompt says so. Without a terminal to
 * ask on, the answer is no.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Workspace } from '@bushwhack/workspace';
import type { Approver, ToolRun, Verdict } from './dispatcher.js';
import type { Scope } from './approval-rules.js';

const PREVIEW_LINES = 60;

function clip(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= PREVIEW_LINES) return text;
  return [...lines.slice(0, PREVIEW_LINES), `… ${lines.length - PREVIEW_LINES} more lines`].join('\n');
}

function unifiedDiff(before: string, after: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bw-diff-'));
  try {
    writeFileSync(join(dir, 'a'), before);
    writeFileSync(join(dir, 'b'), after);
    const out = spawnSync('diff', ['-u', '--label', `${label} (now)`, '--label', `${label} (after)`, join(dir, 'a'), join(dir, 'b')], {
      encoding: 'utf8',
    });
    return out.stdout || '(no change)';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What the operator reads before answering. */
export async function preview(workspace: Workspace, call: ToolRun): Promise<string> {
  const path = String(call.args.path ?? '');
  switch (call.tool) {
    case 'fs:write': {
      let before: string | undefined;
      try {
        before = (await workspace.read(path, 1, 4000)).text;
      } catch {
        before = undefined;
      }
      if (before === undefined) return `new file ${path}\n${clip(call.body ?? '')}`;
      return clip(unifiedDiff(before + '\n', (call.body ?? '') + '\n', path));
    }
    case 'fs:edit':
      return `${path}\n${clip(call.body ?? '')}`;
    case 'fs:move':
      return `${String(call.args.from)} → ${String(call.args.to)}`;
    case 'fs:delete':
      return `delete ${path}`;
    case 'secret:remove':
      return `remove ${String(call.args.name)} from ${String(call.args.file)}`;
    case 'app:exec':
      return `run in the app: ${String(call.args.command)}`;
    case 'app:restart':
      return 'restart the app';
    case 'app:destroy':
      return 'stop and remove the app, its containers and volumes (the project files stay)';
    default:
      return JSON.stringify(call.args);
  }
}

/**
 * One line from a terminal, echoing nothing: raw mode, read keys ourselves. Enter ends it,
 * Backspace erases, Ctrl-C or Ctrl-D gives up (undefined). readline cannot be muted
 * reliably — its echo goes through internals, not the method one would override.
 */
export function readHidden(input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }): Promise<string | undefined> {
  return new Promise((resolve) => {
    let value = '';
    const raw = typeof input.setRawMode === 'function';
    const finish = (result: string | undefined): void => {
      input.removeListener('data', onData);
      if (raw) input.setRawMode!(false);
      input.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return finish(value);
        if (ch === '\u0003' || ch === '\u0004') return finish(undefined);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    if (raw) input.setRawMode!(true);
    input.on('data', onData);
    input.resume();
  });
}

/** A terminal's answer to an approval: yes or no, and what to remember it for. */
export interface TerminalAnswer {
  verdict: 'yes' | 'no';
  /** A pattern, or true for the whole tool. */
  remember?: string | true;
}

/**
 * Ask a terminal. The scopes the answer may be remembered for are shown with the question,
 * numbered, narrowest first; `y` or `n` answers this call only, `y3` / `n2` answers and
 * remembers it for that scope. `a` (always) is yes for the widest. `r` asks the scope, then
 * yes or no, a step at a time. Without scopes (a secret's removal), yes or no only.
 */
export async function askTerminal(question: (prompt: string) => Promise<string>, write: (text: string) => void, scopes: Scope[] = []): Promise<TerminalAnswer> {
  const n = scopes.length;
  if (n > 0) write(`│ remember it for: ${scopes.map((s, i) => `${i + 1} ${s.pattern ?? s.label}`).join(' · ')}\n`);
  const prompt = n > 0 ? `└ approve? [y]es / [n]o — or y1…y${n} / n1…n${n} to remember it: ` : '└ approve? [y]es / [n]o: ';
  const scoped = (verdict: 'yes' | 'no', scope: Scope): TerminalAnswer => ({ verdict, remember: scope.pattern ?? true });
  for (;;) {
    const a = (await question(prompt)).trim().toLowerCase();
    if (a === 'y' || a === 'yes') return { verdict: 'yes' };
    if (a === 'n' || a === 'no') return { verdict: 'no' };
    if (n === 0) continue;
    const at = /^([yn])\s*(\d+)$/.exec(a);
    if (at && scopes[Number(at[2]) - 1]) return scoped(at[1] === 'y' ? 'yes' : 'no', scopes[Number(at[2]) - 1]);
    if (a === 'a' || a === 'always') return scoped('yes', scopes[n - 1]);
    if (a !== 'r' && a !== 'remember') continue;
    write(`${scopes.map((s, i) => `│ ${i + 1}  ${s.label}${s.pattern ? `  ${s.pattern}` : ''}`).join('\n')}\n`);
    let scope: Scope | undefined;
    while (!scope) {
      const k = (await question(`└ remember it for [1-${n}] (empty: back): `)).trim();
      if (k === '') break;
      scope = scopes[Number(k) - 1];
    }
    if (!scope) continue;
    for (;;) {
      const v = (await question(`└ and the answer for ${scope.pattern ?? scope.label}, [y]es or [n]o: `)).trim().toLowerCase();
      if (v === 'y' || v === 'yes') return scoped('yes', scope);
      if (v === 'n' || v === 'no') return scoped('no', scope);
    }
  }
}

export class TerminalApprover implements Approver {
  private queue: Promise<unknown> = Promise.resolve();
  private always = new Set<string>();

  constructor(
    private readonly workspace: Workspace,
    private readonly input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
    /** A preview for tools this module does not know (app:create shows its plan). */
    private readonly extraPreview?: (call: ToolRun) => Promise<string> | undefined,
  ) {}

  ask(call: ToolRun & { id: string }): Promise<Verdict> {
    const next = this.queue.then(() => this.askNow(call));
    this.queue = next.catch(() => undefined);
    return next;
  }

  notice(text: string): void {
    this.output.write(`\n${text}\n`);
  }

  secretValue(request: { id: string; file: string; name: string; description?: string }): Promise<string | undefined> {
    const next = this.queue.then(() => this.readSecret(request));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** A value typed without echo. Nothing typed means no. */
  private async readSecret(request: { id: string; file: string; name: string; description?: string }): Promise<string | undefined> {
    if (!this.input.isTTY) {
      this.output.write(`  ${request.id} secret:add refused: no terminal to ask on\n`);
      return undefined;
    }
    this.output.write(
      `\n┌ ${request.id} secret:add — ${request.name} in ${request.file}\n` +
        (request.description ? `│ ${request.description}\n` : '') +
        `│ the chat never sees what you type here\n`,
    );
    this.output.write(`└ value for ${request.name} (empty to refuse): `);
    const value = await readHidden(this.input);
    this.output.write('\n');
    return value === undefined || value === '' ? undefined : value;
  }

  private async askNow(call: ToolRun & { id: string }): Promise<Verdict> {
    if (this.always.has(call.tool)) {
      this.output.write(`  ${call.id} ${call.tool} approved (always, this session)\n`);
      return 'yes';
    }
    if (!this.input.isTTY) {
      this.output.write(`  ${call.id} ${call.tool} refused: no terminal to ask on\n`);
      return 'no';
    }
    const shown = (await this.extraPreview?.(call)) ?? (await preview(this.workspace, call));
    this.output.write(`\n┌ ${call.id} ${call.tool}\n${shown.replace(/^/gm, '│ ')}\n`);
    const rl = createInterface({ input: this.input, output: this.output });
    try {
      for (;;) {
        const answer = (await rl.question(`└ approve? [y]es / [n]o / [a]lways ${call.tool} this session: `)).trim().toLowerCase();
        if (answer === 'y' || answer === 'yes') return 'yes';
        if (answer === 'n' || answer === 'no') return 'no';
        if (answer === 'a' || answer === 'always') {
          this.always.add(call.tool);
          return 'yes';
        }
      }
    } finally {
      rl.close();
    }
  }
}
