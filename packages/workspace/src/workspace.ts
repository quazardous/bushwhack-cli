/**
 * The project folder, as the chat is allowed to see and change it.
 *
 * Every path goes through `resolve`: relative, normalized, no `..`, then checked twice —
 * once as written and once as `realpath` resolves it. The second check is the one that
 * matters: it is what stops a symlink in the tree from walking out of the folder, or into
 * an ignored file under an innocent name.
 *
 * The root is resolved once, at open, so the folder itself may be a symlink.
 */
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { IGNORE_FILES, IgnoreRules, isRuleFile } from './rules.js';
import { SecretFiles, type SecretFormat } from '@bushwhack/secrets';

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export const LIMITS = {
  /** A file larger than this is not read at all: it is not source code. */
  readFileBytes: 5 * 1024 * 1024,
  /** What one fs:read may send to the chat. */
  readOutBytes: 100 * 1024,
  listEntries: 500,
  searchMatches: 200,
  searchFileBytes: 1024 * 1024,
  searchFiles: 20_000,
  searchLineChars: 200,
} as const;

interface Resolved {
  /** Normalized, relative to the root; '' for the root itself. */
  rel: string;
  /** Where it really is, relative to the root, once symlinks are resolved. */
  realRel: string;
  abs: string;
  exists: boolean;
  isDir: boolean;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class Workspace {
  private readonly rules: IgnoreRules;
  readonly secrets: SecretFiles;

  private constructor(readonly root: string) {
    this.rules = new IgnoreRules(root);
    this.secrets = new SecretFiles(root);
  }

  static async open(folder: string): Promise<Workspace> {
    const root = await realpath(folder);
    if (!(await stat(root)).isDirectory()) throw new WorkspaceError(`${folder} is not a directory`);
    return new Workspace(root);
  }

  private inside(abs: string): boolean {
    return abs === this.root || abs.startsWith(this.root + sep);
  }

  private normalize(path: string): string {
    if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\\')) {
      throw new WorkspaceError(`"${path}": paths are relative to the project root, with / separators`);
    }
    const rel = posix.normalize(path).replace(/\/+$/, '');
    if (rel === '..' || rel.startsWith('../')) throw new WorkspaceError(`"${path}" leaves the project`);
    return rel === '.' ? '' : rel;
  }

  /**
   * Declaring a secret file makes it visible — scrambled — even when git ignores it (an
   * `.env` usually is): the declaration is the operator saying the chat may see its shape.
   * Nothing inside `.git/` or `.bushwhack/` is ever visible, declared or not.
   */
  private async hidden(rel: string, isDir: boolean): Promise<boolean> {
    if (!isDir && !this.rules.inHiddenDir(rel) && (await this.secrets.formatOf(rel))) return false;
    return this.rules.isHidden(rel, isDir);
  }

  /** The secret format of a resolved path, by where it is written or where it really is. */
  private async secretFormat(target: Resolved): Promise<SecretFormat | undefined> {
    return (await this.secrets.formatOf(target.rel)) ?? (await this.secrets.formatOf(target.realRel));
  }

  /**
   * Resolve a request path. A hidden path answers exactly like a missing one, so the chat
   * cannot probe which ignored files exist.
   */
  async resolve(path: string, options: { write?: boolean } = {}): Promise<Resolved> {
    const rel = this.normalize(path);
    const abs = rel === '' ? this.root : join(this.root, rel);
    const missing = new WorkspaceError(`"${rel || '.'}" does not exist`);

    let info;
    try {
      info = await lstat(abs);
    } catch {
      info = undefined;
    }

    if (info === undefined) {
      if (await this.hidden(rel, false)) throw options.write ? this.hiddenForWrite(rel) : missing;
      if (!options.write) throw missing;
      // A new file: its nearest existing ancestor must really be inside the folder.
      let parent = dirname(abs);
      for (;;) {
        try {
          const real = await realpath(parent);
          if (!this.inside(real)) throw new WorkspaceError(`"${rel}" leaves the project through a symlink`);
          const parentRel = relative(this.root, real).split(sep).join('/');
          if (await this.hidden(parentRel, true)) throw this.hiddenForWrite(rel);
          break;
        } catch (e) {
          if (e instanceof WorkspaceError) throw e;
          parent = dirname(parent);
        }
      }
      return { rel, realRel: rel, abs, exists: false, isDir: false };
    }

    const real = await realpath(abs).catch(() => undefined);
    if (real === undefined || !this.inside(real)) {
      if (options.write) throw new WorkspaceError(`"${rel}" leaves the project through a symlink`);
      throw missing;
    }
    const isDir = (await stat(real)).isDirectory();
    const realRel = relative(this.root, real).split(sep).join('/');
    if ((await this.hidden(rel, isDir)) || (await this.hidden(realRel, isDir))) {
      throw options.write ? this.hiddenForWrite(rel) : missing;
    }
    if (options.write && info.isSymbolicLink()) {
      throw new WorkspaceError(`"${rel}" is a symlink; write to "${realRel}" instead`);
    }
    return { rel, realRel, abs: options.write ? abs : real, exists: true, isDir };
  }

  private hiddenForWrite(rel: string): WorkspaceError {
    return new WorkspaceError(`"${rel}" is ignored (or inside .git) and cannot be written`);
  }

  private async writable(path: string): Promise<Resolved> {
    const target = await this.resolve(path, { write: true });
    if (target.rel === '') throw new WorkspaceError('the project root itself cannot be written');
    if (isRuleFile(target.rel)) {
      throw new WorkspaceError(`"${target.rel}" is an ignore file: it decides what you can see — add a rule with ignore:add; rules are never removed from here`);
    }
    if (await this.secretFormat(target)) {
      throw new WorkspaceError(`"${target.rel}" is a declared secret file: change it with secret:add and secret:remove`);
    }
    return target;
  }

  /**
   * A root ignore file, for the ignore:* tools only: its rules, or one rule added at its
   * end — never anything that could show more (a negation, a rule removed or changed).
   * Created when it does not exist yet.
   */
  ignoreFile(name: string): { rel: string; rules(): Promise<string[]>; add(rule: string): Promise<'added' | 'present'> } {
    if (!(IGNORE_FILES as readonly string[]).includes(name)) throw new WorkspaceError(`"${name}" is not an ignore file (${IGNORE_FILES.join(', ')})`);
    const abs = join(this.root, name);
    // A link would take the read, or the write, out of the project.
    const read = async (): Promise<string> => {
      const info = await lstat(abs).catch(() => undefined);
      if (!info) return '';
      if (!info.isFile()) throw new WorkspaceError(`"${name}" is not a plain file (a link?): not from here`);
      return readFile(abs, 'utf8');
    };
    return {
      rel: name,
      rules: async () => (await read()).split('\n').filter((l) => l.trim() !== ''),
      add: async (raw) => {
        const rule = checkIgnoreRule(raw);
        const text = await read();
        if (text.split('\n').some((l) => l.trim() === rule)) return 'present';
        await writeFile(abs, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${rule}\n`);
        return 'added';
      },
    };
  }

  /**
   * A declared secret file, raw — for the secret:* tools only, which never send a value to
   * the chat. Created 0600 when it does not exist yet.
   */
  async secretFile(path: string): Promise<{ rel: string; format: SecretFormat; read(): Promise<string>; write(text: string): Promise<void> }> {
    const rel = this.normalize(path);
    const format = await this.secrets.formatOf(rel);
    if (!format) throw new WorkspaceError(`"${rel}" is not a declared secret file (the operator declares them)`);
    const target = await this.resolve(rel, { write: true });
    return {
      rel,
      format,
      read: async () => (target.exists ? readFile(target.abs, 'utf8') : ''),
      write: async (text) => this.replace({ ...target, exists: target.exists }, text, 0o600),
    };
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  async list(path: string, depth: number): Promise<{ text: string; entries: number; hidden: number; truncated: boolean }> {
    const start = await this.resolve(path);
    if (!start.isDir) throw new WorkspaceError(`"${start.rel}" is a file; use fs:read`);

    const out: string[] = [];
    let hidden = 0;
    let truncated = false;

    const walk = async (rel: string, abs: string, level: number): Promise<void> => {
      const dirents = await readdir(abs, { withFileTypes: true });
      dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const dirent of dirents) {
        if (out.length >= LIMITS.listEntries) {
          truncated = true;
          return;
        }
        const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
        const childAbs = join(abs, dirent.name);
        const indent = '  '.repeat(level);
        if (dirent.isSymbolicLink()) {
          // Listed only when it resolves inside and to something visible — the same
          // answer resolve() would give.
          try {
            const target = await this.resolve(childRel);
            out.push(`${indent}${dirent.name}${target.isDir ? '/' : ''} -> ${target.rel}`);
          } catch {
            hidden++;
          }
          continue;
        }
        const isDir = dirent.isDirectory();
        if (await this.hidden(childRel, isDir)) {
          hidden++;
          continue;
        }
        if (isDir) {
          out.push(`${indent}${dirent.name}/`);
          if (level + 1 < depth) await walk(childRel, childAbs, level + 1);
        } else {
          const size = (await lstat(childAbs)).size;
          out.push(`${indent}${dirent.name}  (${humanSize(size)})`);
        }
      }
    };

    await walk(start.rel, start.abs, 0);
    return { text: out.join('\n'), entries: out.length, hidden, truncated };
  }

  async read(path: string, from: number, count: number): Promise<{ text: string; range: string; truncated: boolean }> {
    const file = await this.resolve(path);
    if (file.isDir) throw new WorkspaceError(`"${file.rel}" is a directory; use fs:list`);
    const size = (await stat(file.abs)).size;
    if (size > LIMITS.readFileBytes) {
      throw new WorkspaceError(`"${file.rel}" is ${humanSize(size)}; fs:read stops at ${humanSize(LIMITS.readFileBytes)}`);
    }
    const buffer = await readFile(file.abs);
    if (isBinary(buffer)) throw new WorkspaceError(`"${file.rel}" is a binary file`);

    const format = await this.secretFormat(file);
    const text = format ? this.secrets.scramble(format, buffer.toString('utf8')) : buffer.toString('utf8');
    const lines = text.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    if (from > Math.max(total, 1)) throw new WorkspaceError(`"${file.rel}" has ${total} lines; from=${from} is past the end`);

    const picked: string[] = [];
    let bytes = 0;
    let truncated = false;
    for (let i = from - 1; i < Math.min(total, from - 1 + count); i++) {
      const size = Buffer.byteLength(lines[i]) + 1;
      if (bytes + size > LIMITS.readOutBytes) {
        truncated = true;
        break;
      }
      picked.push(lines[i]);
      bytes += size;
    }
    const last = from - 1 + picked.length;
    if (last < total) truncated = true;
    return { text: picked.join('\n'), range: total === 0 ? '0 of 0' : `${from}-${last} of ${total}`, truncated };
  }

  async search(text: string, path: string, ignoreCase: boolean): Promise<{ text: string; matches: number; truncated: boolean }> {
    const start = await this.resolve(path);
    const needle = ignoreCase ? text.toLowerCase() : text;
    const out: string[] = [];
    let files = 0;
    let truncated = false;

    const scanFile = async (rel: string, abs: string): Promise<void> => {
      if (++files > LIMITS.searchFiles) {
        truncated = true;
        return;
      }
      if ((await stat(abs)).size > LIMITS.searchFileBytes) return;
      const buffer = await readFile(abs);
      if (isBinary(buffer)) return;
      // A declared secret file is searched as the chat sees it: a match on a value would
      // tell the chat what the value is.
      const format = await this.secrets.formatOf(rel);
      const lines = (format ? this.secrets.scramble(format, buffer.toString('utf8')) : buffer.toString('utf8')).split('\n');
      for (const [i, line] of lines.entries()) {
        if (!(ignoreCase ? line.toLowerCase() : line).includes(needle)) continue;
        if (out.length >= LIMITS.searchMatches) {
          truncated = true;
          return;
        }
        const shown = line.trim();
        out.push(`${rel}:${i + 1}: ${shown.length > LIMITS.searchLineChars ? shown.slice(0, LIMITS.searchLineChars) + '…' : shown}`);
      }
    };

    const walk = async (rel: string, abs: string): Promise<void> => {
      for (const dirent of await readdir(abs, { withFileTypes: true })) {
        if (truncated) return;
        // Symlinks are not followed by search: their targets are reached, if visible, under their own names.
        if (dirent.isSymbolicLink()) continue;
        const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
        const isDir = dirent.isDirectory();
        if (await this.hidden(childRel, isDir)) continue;
        if (isDir) await walk(childRel, join(abs, dirent.name));
        else if (dirent.isFile()) await scanFile(childRel, join(abs, dirent.name));
      }
    };

    if (start.isDir) await walk(start.rel, start.abs);
    else await scanFile(start.rel, start.abs);
    return { text: out.join('\n'), matches: out.length, truncated };
  }

  // ─── Writing ──────────────────────────────────────────────────────────────

  /**
   * Replace a file whole, through a temporary file and a rename: a reader never sees half
   * a file, and a rename replaces a path — it does not write through whatever it pointed to.
   */
  private async replace(target: Resolved, content: string | Uint8Array, newMode = 0o644): Promise<void> {
    await mkdir(dirname(target.abs), { recursive: true });
    const mode = (await stat(target.abs).then((s) => s.mode & 0o777, () => undefined)) ?? newMode;
    const temp = join(dirname(target.abs), `.bushwhack-${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      await (typeof content === 'string' ? handle.writeFile(content, 'utf8') : handle.writeFile(content));
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, target.abs);
    } catch (e) {
      await rm(temp, { force: true });
      throw e;
    }
  }

  async write(path: string, content: string): Promise<{ rel: string; created: boolean; bytes: number }> {
    const target = await this.writable(path);
    if (target.isDir) throw new WorkspaceError(`"${target.rel}" is a directory`);
    await this.replace(target, content);
    return { rel: target.rel, created: !target.exists, bytes: Buffer.byteLength(content) };
  }

  /** A file of bytes — a picture — written whole, like `write`. */
  async writeBytes(path: string, bytes: Uint8Array): Promise<{ rel: string; created: boolean; bytes: number }> {
    const target = await this.writable(path);
    if (target.isDir) throw new WorkspaceError(`"${target.rel}" is a directory`);
    await this.replace(target, bytes);
    return { rel: target.rel, created: !target.exists, bytes: bytes.length };
  }

  async edit(path: string, edits: Edit[]): Promise<{ rel: string; applied: number }> {
    const target = await this.writable(path);
    if (!target.exists) throw new WorkspaceError(`"${target.rel}" does not exist; use fs:write to create it`);
    if (target.isDir) throw new WorkspaceError(`"${target.rel}" is a directory`);
    let text = await readFile(target.abs, 'utf8');
    for (const [i, edit] of edits.entries()) {
      const count = text.split(edit.search).length - 1;
      if (count !== 1) {
        throw new WorkspaceError(
          `edit ${i + 1}: the SEARCH text is found ${count} times in "${target.rel}"; it must be found exactly once` +
            (count === 0 ? ' — read the file again, it may have changed' : ' — include more surrounding lines'),
        );
      }
      text = text.replace(edit.search, () => edit.replace);
    }
    await this.replace(target, text);
    return { rel: target.rel, applied: edits.length };
  }

  async move(from: string, to: string): Promise<{ from: string; to: string }> {
    const source = await this.writable(from);
    if (!source.exists) throw new WorkspaceError(`"${source.rel}" does not exist`);
    // Directories stay put: one of their entries may be ignored by a rule that names its
    // path, and would come out the other side visible.
    if (source.isDir) throw new WorkspaceError(`"${source.rel}" is a directory; move its files one by one`);
    const target = await this.writable(to);
    if (target.exists) throw new WorkspaceError(`"${target.rel}" already exists`);
    await mkdir(dirname(target.abs), { recursive: true });
    await rename(source.abs, target.abs);
    return { from: source.rel, to: target.rel };
  }

  async delete(path: string): Promise<{ rel: string; kind: 'file' | 'directory' }> {
    const target = await this.writable(path);
    if (!target.exists) throw new WorkspaceError(`"${target.rel}" does not exist`);
    if (target.isDir) {
      // Non-empty directories may hold ignored files the chat cannot see — and must not destroy.
      if ((await readdir(target.abs)).length > 0) throw new WorkspaceError(`"${target.rel}" is not empty`);
      await rmdir(target.abs);
      return { rel: target.rel, kind: 'directory' };
    }
    await unlink(target.abs);
    return { rel: target.rel, kind: 'file' };
  }
}

export interface Edit {
  search: string;
  replace: string;
}

const SEARCH = '<<<<<<< SEARCH';
const DIVIDER = '=======';
const REPLACE = '>>>>>>> REPLACE';

/** The fs:edit body: one or more SEARCH/REPLACE blocks, the shape models already know from diff3 and aider. */
export function parseEdits(body: string): Edit[] {
  const lines = body.split('\n');
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i++;
      continue;
    }
    if (lines[i].trimEnd() !== SEARCH) throw new WorkspaceError(`line ${i + 1}: expected "${SEARCH}"`);
    const divider = lines.findIndex((line, j) => j > i && line.trimEnd() === DIVIDER);
    if (divider < 0) throw new WorkspaceError(`line ${i + 1}: "${SEARCH}" without "${DIVIDER}"`);
    const end = lines.findIndex((line, j) => j > divider && line.trimEnd() === REPLACE);
    if (end < 0) throw new WorkspaceError(`line ${divider + 1}: "${DIVIDER}" without "${REPLACE}"`);
    const search = lines.slice(i + 1, divider).join('\n');
    if (search === '') throw new WorkspaceError(`line ${i + 1}: the SEARCH text is empty`);
    edits.push({ search, replace: lines.slice(divider + 1, end).join('\n') });
    i = end + 1;
  }
  if (edits.length === 0) throw new WorkspaceError('no SEARCH/REPLACE block in the body');
  return edits;
}

/**
 * An ignore rule the chat may add: one line, and one that can only hide more. A negation
 * (`!…`) shows what a rule hid; an empty line or a comment adds nothing.
 */
export function checkIgnoreRule(raw: string): string {
  const rule = raw.trim();
  if (rule === '' || /[\r\n]/.test(raw)) throw new WorkspaceError('a rule is one non-empty line');
  if (rule.startsWith('!')) throw new WorkspaceError('a rule starting with "!" would show what another hides: not from here');
  if (rule.startsWith('#')) throw new WorkspaceError('a comment is not a rule');
  if (rule.length > 200) throw new WorkspaceError('a rule is at most 200 characters');
  return rule;
}
