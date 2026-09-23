/**
 * The project's declared secret files.
 *
 * Declared by the operator in `.bushwhack/secrets.jsonc` — a place the chat cannot see:
 *
 *     { "files": { "app/.env": { "format": "dotenv" } } }
 *
 * A declared file is readable by the chat with its values scrambled, is never written by
 * the fs:* tools, and its values are masked in anything else the chat is sent. Declaring
 * is what protects: an undeclared .env follows the ordinary rules.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import stripJsonComments from 'strip-json-comments';
import { dotenvValues, placeholder, scrambleDotenv } from './dotenv.js';

export const DECLARATIONS = '.bushwhack/secrets.jsonc';

export const DECLARATIONS_TEMPLATE = `// Files holding secrets. The chat sees them with every value masked, and changes them
// only through the secret:* tools, with the values typed in the serve terminal.
// Paths are relative to the project. Formats: "dotenv".
{
  "files": {
    // "app/.env": { "format": "dotenv" }
  }
}
`;

export type SecretFormat = 'dotenv';

/** Values shorter than this are not masked elsewhere: "true" or "3000" would garble every output. */
export const MIN_MASKED_LENGTH = 6;

export class DeclarationError extends Error {}

export class SecretFiles {
  private cache: { key: string; files: Map<string, SecretFormat> } | undefined;

  constructor(private readonly root: string) {}

  private async declarations(): Promise<Map<string, SecretFormat>> {
    const file = join(this.root, DECLARATIONS);
    const key = await stat(file).then((s) => `${s.mtimeMs}:${s.size}`, () => '-');
    if (this.cache?.key === key) return this.cache.files;

    const files = new Map<string, SecretFormat>();
    if (key !== '-') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripJsonComments(await readFile(file, 'utf8')));
      } catch (e) {
        throw new DeclarationError(`${DECLARATIONS}: ${(e as Error).message}`);
      }
      const declared = (parsed as { files?: unknown })?.files;
      if (declared !== undefined && (typeof declared !== 'object' || declared === null)) {
        throw new DeclarationError(`${DECLARATIONS}: "files" must be an object`);
      }
      for (const [path, spec] of Object.entries(declared ?? {})) {
        const rel = posix.normalize(path).replace(/\/+$/, '');
        if (rel.startsWith('/') || rel === '..' || rel.startsWith('../')) {
          throw new DeclarationError(`${DECLARATIONS}: "${path}" is not a path inside the project`);
        }
        const format = (spec as { format?: unknown })?.format;
        if (format !== 'dotenv') throw new DeclarationError(`${DECLARATIONS}: "${path}": format must be "dotenv"`);
        files.set(rel, format);
      }
    }
    this.cache = { key, files };
    return files;
  }

  /** The format of a declared file, by its normalized relative path. */
  async formatOf(rel: string): Promise<SecretFormat | undefined> {
    return (await this.declarations()).get(rel);
  }

  async list(): Promise<string[]> {
    return [...(await this.declarations()).keys()];
  }

  scramble(_format: SecretFormat, text: string): string {
    return scrambleDotenv(text);
  }

  /**
   * Replace every value of every declared file found in `text` by its placeholder, longest
   * first so that a value containing another is masked whole.
   */
  async redactor(): Promise<(text: string) => string> {
    const pairs: [string, string][] = [];
    for (const rel of await this.list()) {
      const text = await readFile(join(this.root, rel), 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      for (const [name, value] of dotenvValues(text)) {
        if (value.length >= MIN_MASKED_LENGTH) pairs.push([value, placeholder(name)]);
      }
    }
    pairs.sort((a, b) => b[0].length - a[0].length);
    if (pairs.length === 0) return (text) => text;
    return (text) => pairs.reduce((out, [value, mask]) => out.split(value).join(mask), text);
  }
}
