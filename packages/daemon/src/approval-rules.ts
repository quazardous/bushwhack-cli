/**
 * The approvals the operator asked to be remembered: a project's rules, kept in its
 * `.bushwhack/approval-rules.json` — across restarts, readable and editable by hand, and out
 * of the model's reach (`.bushwhack/` does not exist for it).
 *
 * A rule answers yes or no, for a kind of tool and, for the tools that touch a file, a
 * pattern of paths: `*` stands for any name within a folder, `**` for any path. Nothing
 * else — a rule reads at a glance. When several apply, the most precise one wins; between
 * two as precise, no wins.
 *
 *   { "rules": [ { "tools": "change", "pattern": "**\/*.js", "answer": "yes", "at": "…" } ] }
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RULES_FILE = 'approval-rules.json';

export type Answer = 'yes' | 'no';

export interface Rule {
  /** `change` (fs:write and fs:edit), `fs:delete`, `fs:move`, or a tool without a path. */
  tools: string;
  /** The paths it covers — only for the tools that touch a file. */
  pattern?: string;
  answer: Answer;
  at: string;
}

/** The tools that touch one file, and what their rules are kept under. */
const PATH_TOOLS: Record<string, string> = { 'fs:write': 'change', 'fs:edit': 'change', 'fs:delete': 'fs:delete', 'fs:move': 'fs:move' };
const KINDS = new Set(Object.values(PATH_TOOLS));

/** What a tool's rules are kept under: `change` for writes and edits, else the tool itself. */
export function kindOf(tool: string): string {
  return PATH_TOOLS[tool] ?? tool;
}

export function takesPattern(tool: string): boolean {
  return tool in PATH_TOOLS;
}

/** A secret is never answered by a rule: each value, each removal, is the operator's again. */
export function rememberable(tool: string): boolean {
  return !tool.startsWith('secret:');
}

/** A project-relative path, as rules see it: forward slashes, no `./`. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

/** Why a pattern is not one, or undefined: relative, no `..`, only `*` and `**` as wildcards. */
export function patternProblem(pattern: string): string | undefined {
  if (pattern === '') return 'an empty pattern';
  if (pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)) return 'a pattern is relative to the project';
  const parts = pattern.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return 'no "..", "." or empty part in a pattern';
  if (parts.some((p) => p.includes('**') && p !== '**')) return '"**" stands alone between slashes';
  if (/[?[\]{}!]/.test(pattern)) return 'only * and ** are wildcards';
  return undefined;
}

function segmentMatches(pattern: string, name: string, fold: boolean): boolean {
  const escaped = pattern.split('*').map((s) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&'));
  return new RegExp(`^${escaped.join('[^/]*')}$`, fold ? 'i' : '').test(name);
}

/** Whether a pattern covers a path. `fold`: names compare without case (Windows). */
export function matches(pattern: string, path: string, fold = false): boolean {
  const pat = pattern.split('/');
  const parts = normalizePath(path).split('/');
  const walk = (i: number, j: number): boolean => {
    if (i === pat.length) return j === parts.length;
    if (pat[i] === '**') {
      for (let k = j; k <= parts.length; k++) if (walk(i + 1, k)) return true;
      return false;
    }
    return j < parts.length && segmentMatches(pat[i], parts[j], fold) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

/** How precise a pattern is: a path with no wildcard beats all; else the more literal text, the more precise. */
export function precision(pattern: string | undefined): number {
  if (pattern === undefined) return -1;
  if (!pattern.includes('*')) return Number.MAX_SAFE_INTEGER;
  return pattern.replace(/\*/g, '').length;
}

export interface Scope {
  label: string;
  /** Undefined: the tool, whatever it acts on. */
  pattern?: string;
}

/**
 * What the operator may remember an answer for, narrowest first: this file, its kind in its
 * folder, its kind anywhere, everything. A file without an extension: this file, its folder,
 * everything.
 */
export function scopesFor(tool: string, path: string | undefined): Scope[] {
  if (!takesPattern(tool) || !path) return [{ label: `every ${tool}` }];
  const file = normalizePath(path);
  const slash = file.lastIndexOf('/');
  const dir = slash < 0 ? '' : file.slice(0, slash + 1);
  const name = file.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const scopes: Scope[] = [{ label: 'this file', pattern: file }];
  if (ext) {
    scopes.push({ label: `the ${ext} files ${dir ? 'in this folder' : 'at the top'}`, pattern: `${dir}*${ext}` });
    scopes.push({ label: `every ${ext} file`, pattern: `**/*${ext}` });
  } else if (dir) {
    scopes.push({ label: 'this folder', pattern: `${dir}*` });
  }
  scopes.push({ label: 'every file', pattern: '**' });
  // `*.js` at the top and `**/*.js` differ; the same pattern twice does not.
  return scopes.filter((s, i) => scopes.findIndex((o) => o.pattern === s.pattern) === i);
}

/** The rule that answers this call, if one does: the most precise that applies; no wins a tie. */
export function decide(rules: Rule[], tool: string, path: string | undefined, fold = false): Rule | undefined {
  const kind = kindOf(tool);
  const applying = rules.filter((r) => r.tools === kind && (r.pattern === undefined ? true : path !== undefined && matches(r.pattern, path, fold)));
  return applying.sort((a, b) => precision(b.pattern) - precision(a.pattern) || (a.answer === 'no' ? -1 : 0) - (b.answer === 'no' ? -1 : 0))[0];
}

/** How a rule reads: `change **\/*.js`, `app:exec`. */
export function describeRule(rule: Pick<Rule, 'tools' | 'pattern'>): string {
  return rule.pattern === undefined ? rule.tools : `${rule.tools} ${rule.pattern}`;
}

/** The file's rules, or why it is not valid. */
export function parseRules(text: string): { rules: Rule[] } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: `not JSON: ${(e as Error).message}` };
  }
  const list = (data as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(list)) return { error: 'no "rules" list' };
  const rules: Rule[] = [];
  for (const [i, raw] of list.entries()) {
    const r = raw as Partial<Rule> | null;
    const where = `rule ${i + 1}`;
    if (!r || typeof r.tools !== 'string' || r.tools === '') return { error: `${where}: "tools" is missing` };
    if (r.answer !== 'yes' && r.answer !== 'no') return { error: `${where}: "answer" is "yes" or "no"` };
    if (r.tools.startsWith('secret:')) return { error: `${where}: a secret is always asked` };
    if (r.tools in PATH_TOOLS && !KINDS.has(r.tools)) return { error: `${where}: ${r.tools} rules are under "${kindOf(r.tools)}"` };
    if (KINDS.has(r.tools)) {
      if (typeof r.pattern !== 'string') return { error: `${where}: ${r.tools} needs a "pattern"` };
      const problem = patternProblem(r.pattern);
      if (problem) return { error: `${where}: ${problem}` };
    } else if (r.pattern !== undefined) {
      return { error: `${where}: ${r.tools} takes no "pattern"` };
    }
    rules.push({ tools: r.tools, ...(r.pattern !== undefined ? { pattern: r.pattern } : {}), answer: r.answer, at: typeof r.at === 'string' ? r.at : '' });
  }
  return { rules };
}

/** A project's rules file: read at each question, so a change by hand counts at once. */
export class RuleStore {
  readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, RULES_FILE);
  }

  /** The rules; none when there is no file; an error when it is not valid (then it counts for nothing). */
  async load(): Promise<{ rules: Rule[]; error?: string }> {
    const text = await readFile(this.file, 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? undefined : Promise.reject(e)));
    if (text === undefined) return { rules: [] };
    const parsed = parseRules(text);
    return 'error' in parsed ? { rules: [], error: `${RULES_FILE}: ${parsed.error}` } : parsed;
  }

  /** Remember a rule — in place of one for the same tools and pattern. Refused over a file not valid: it is the operator's to fix. */
  async add(rule: Omit<Rule, 'at'>): Promise<Rule> {
    const { rules, error } = await this.load();
    if (error) throw new Error(`${error} — fix it first; nothing was remembered`);
    const made: Rule = { ...rule, at: new Date().toISOString() };
    const kept = rules.filter((r) => !(r.tools === made.tools && r.pattern === made.pattern));
    await this.save([...kept, made]);
    return made;
  }

  /** Forget the rules a `what` names: a tool (`fs:write` names `change`), a pattern, a rule as described, or all. */
  async forget(what?: string): Promise<Rule[]> {
    const { rules, error } = await this.load();
    if (error) throw new Error(`${error} — fix it first`);
    const gone = rules.filter((r) => what === undefined || r.tools === kindOf(what) || r.pattern === what || describeRule(r) === what);
    if (gone.length > 0) await this.save(rules.filter((r) => !gone.includes(r)));
    return gone;
  }

  private async save(rules: Rule[]): Promise<void> {
    await writeFile(this.file, `${JSON.stringify({ rules }, null, 2)}\n`, { mode: 0o600 });
  }
}
