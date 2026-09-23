/**
 * Which paths exist for the chat.
 *
 * Ignored paths do not merely stay unreadable — they do not exist for any `fs:*` call,
 * read or write. Filtering reads alone would be a door with a lock and no wall: move
 * `.env` to `env.txt`, or add `!.env` to a `.gitignore`, and the next read goes through.
 * So an ignored path can be neither a source nor a destination, and ignore files cannot
 * be written at all.
 *
 * Rules follow git: every directory may hold a `.gitignore` (and a `.bushwhackignore`,
 * same syntax, for what git tracks but the chat must not see); the deepest file that has
 * an opinion wins; and once a directory is ignored nothing under it can be re-included.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import ignore, { type Ignore } from 'ignore';

export const IGNORE_FILES = ['.gitignore', '.bushwhackignore'] as const;

/**
 * Never visible, at any depth, whatever the ignore files say: git's own directory holds
 * hooks (host code execution) and remote URLs with tokens; `.bushwhack/` holds the session's
 * pairing code, replay store and secret-file declarations.
 */
const HIDDEN_NAMES = new Set(['.git', '.bushwhack']);

interface Cached {
  key: string;
  rules: Ignore;
}

export class IgnoreRules {
  private cache = new Map<string, Cached>();

  constructor(private readonly root: string) {}

  /** Rules declared in one directory (relative, '' for the root), reloaded when a file changes. */
  private async rulesFor(dir: string): Promise<Ignore> {
    const files = IGNORE_FILES.map((name) => join(this.root, dir, name));
    const stamps = await Promise.all(
      files.map((file) => stat(file).then((s) => `${s.mtimeMs}:${s.size}`, () => '-')),
    );
    const key = stamps.join('|');
    const cached = this.cache.get(dir);
    if (cached?.key === key) return cached.rules;

    const rules = ignore();
    for (const [i, file] of files.entries()) {
      if (stamps[i] !== '-') rules.add(await readFile(file, 'utf8'));
    }
    this.cache.set(dir, { key, rules });
    return rules;
  }

  /** One path, deciding with the deepest ignore file that has an opinion. */
  private async decide(parts: string[], isDir: boolean): Promise<boolean> {
    for (let depth = parts.length - 1; depth >= 0; depth--) {
      const dir = parts.slice(0, depth).join('/');
      const rel = parts.slice(depth).join('/') + (isDir ? '/' : '');
      const verdict = (await this.rulesFor(dir)).test(rel);
      if (verdict.ignored) return true;
      if (verdict.unignored) return false;
    }
    return false;
  }

  /**
   * Whether a normalized relative path is hidden from the chat. `isDir` matters: `build/`
   * in a `.gitignore` matches a directory named build, not a file.
   */
  /** Inside `.git/` or `.bushwhack/`: hidden whatever else is declared. */
  inHiddenDir(rel: string): boolean {
    return rel.split('/').some((part) => HIDDEN_NAMES.has(part));
  }

  async isHidden(rel: string, isDir: boolean): Promise<boolean> {
    if (rel === '' || rel === '.') return false;
    const parts = rel.split('/');
    if (this.inHiddenDir(rel)) return true;
    for (let i = 1; i <= parts.length; i++) {
      const last = i === parts.length;
      if (await this.decide(parts.slice(0, i), last ? isDir : true)) return true;
    }
    return false;
  }
}

/** Ignore files are the rules themselves: the chat may read them, never change them. */
export function isRuleFile(rel: string): boolean {
  const name = rel.split('/').pop() ?? '';
  return (IGNORE_FILES as readonly string[]).includes(name);
}
