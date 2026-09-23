/**
 * The replay store. Chat UIs re-render, pages reload, the extension restarts: the same
 * call block will be seen again. A call is identified by its conversation and the id the
 * model gave it; the store keeps what it answered, so a replay gets the same answer and
 * nothing runs twice.
 *
 * Kept as JSON lines in the session state directory, so a daemon restart does not turn
 * yesterday's `fs:write` into today's.
 */
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import type { Result } from '@bushwhack/protocol';

interface Entry {
  key: string;
  hash: string;
  result: Result;
}

export type Lookup =
  | { kind: 'new' }
  | { kind: 'replay'; result: Result }
  /** Same conversation, same id, different call: the model reused an id. */
  | { kind: 'conflict' };

export function hashCall(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}

export class CallStore {
  private entries = new Map<string, Entry>();

  private constructor(private readonly file: string | undefined) {}

  static memory(): CallStore {
    return new CallStore(undefined);
  }

  static async open(file: string): Promise<CallStore> {
    const store = new CallStore(file);
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const entry = JSON.parse(line) as Entry;
        store.entries.set(entry.key, entry);
      } catch {
        // A torn last line from a crash: the call it recorded will simply run again.
      }
    }
    return store;
  }

  private static key(conversation: string, id: string): string {
    return `${conversation}\u0000${id}`;
  }

  lookup(conversation: string, id: string, hash: string): Lookup {
    const entry = this.entries.get(CallStore.key(conversation, id));
    if (!entry) return { kind: 'new' };
    return entry.hash === hash ? { kind: 'replay', result: entry.result } : { kind: 'conflict' };
  }

  /** A call's recorded result — as the chat got it, masked. */
  resultOf(conversation: string, id: string): Result | undefined {
    return this.entries.get(CallStore.key(conversation, id))?.result;
  }

  async record(conversation: string, id: string, hash: string, result: Result): Promise<void> {
    const entry: Entry = { key: CallStore.key(conversation, id), hash, result };
    this.entries.set(entry.key, entry);
    if (this.file) await appendFile(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }
}
