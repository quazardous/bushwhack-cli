/**
 * The answers the operator asked to remember: patterns, the scopes offered, which rule wins,
 * and the file they are kept in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, matches, parseRules, patternProblem, RuleStore, scopesFor, type Rule } from './approval-rules.js';
import { askTerminal } from './approval.js';

const rule = (tools: string, pattern: string | undefined, answer: 'yes' | 'no'): Rule => ({ tools, ...(pattern !== undefined ? { pattern } : {}), answer, at: '' });

describe('approval rules', () => {
  it('matches * within a folder and ** across folders, nothing else', () => {
    expect(matches('src/app/main.js', 'src/app/main.js')).toBe(true);
    expect(matches('src/app/*.js', 'src/app/util.js')).toBe(true);
    expect(matches('src/app/*.js', 'src/app/deep/util.js')).toBe(false);
    expect(matches('**/*.js', 'main.js')).toBe(true);
    expect(matches('**/*.js', 'a/b/c/main.js')).toBe(true);
    expect(matches('**/*.js', 'a/b/main.json')).toBe(false);
    expect(matches('**', 'anything/at/all.txt')).toBe(true);
    expect(matches('src/**', 'src/a/b.txt')).toBe(true);
    expect(matches('src/**', 'lib/a.txt')).toBe(false);
    expect(matches('*.js', 'src/main.js')).toBe(false);
    // Dots and brackets are themselves, not regular expressions.
    expect(matches('a.js', 'abjs')).toBe(false);
    expect(matches('src/*.js', './src\\main.js')).toBe(true);
  });

  it('folds case only where the file system does', () => {
    expect(matches('src/*.JS', 'SRC/main.js')).toBe(false);
    expect(matches('src/*.JS', 'SRC/main.js', true)).toBe(true);
  });

  it('refuses a pattern that could reach outside, or reads as more than * and **', () => {
    expect(patternProblem('**/*.js')).toBeUndefined();
    for (const bad of ['', '/etc/*', 'C:/x', '../*', 'a/../b', 'a//b', './a', 'src**/x', 'a?.js', '{a,b}.js', '!a.js']) expect(patternProblem(bad), bad).toBeDefined();
  });

  it('offers scopes from the path, narrowest first', () => {
    expect(scopesFor('fs:edit', 'src/app/main.js').map((s) => s.pattern)).toEqual(['src/app/main.js', 'src/app/*.js', '**/*.js', '**']);
    expect(scopesFor('fs:write', 'index.html').map((s) => s.pattern)).toEqual(['index.html', '*.html', '**/*.html', '**']);
    expect(scopesFor('fs:delete', 'bin/run').map((s) => s.pattern)).toEqual(['bin/run', 'bin/*', '**']);
    expect(scopesFor('fs:write', 'Makefile').map((s) => s.pattern)).toEqual(['Makefile', '**']);
    expect(scopesFor('app:exec', undefined)).toEqual([{ label: 'every app:exec' }]);
  });

  it('lets the most precise rule answer; between two as precise, no', () => {
    const rules = [rule('change', '**/*.js', 'yes'), rule('change', 'src/secret/*.js', 'no'), rule('change', 'src/secret/ok.js', 'yes')];
    expect(decide(rules, 'fs:edit', 'lib/a.js')?.answer).toBe('yes');
    expect(decide(rules, 'fs:write', 'src/secret/b.js')?.answer).toBe('no');
    expect(decide(rules, 'fs:write', 'src/secret/ok.js')?.answer).toBe('yes');
    expect(decide(rules, 'fs:delete', 'lib/a.js')).toBeUndefined();
    expect(decide([rule('change', 'src/*', 'yes'), rule('change', 'src/*', 'no')], 'fs:edit', 'src/a')?.answer).toBe('no');
    expect(decide([rule('app:exec', undefined, 'yes')], 'app:exec', undefined)?.answer).toBe('yes');
  });

  it('says what is wrong in a file written by hand', () => {
    expect(parseRules('{ "rules": [] }')).toEqual({ rules: [] });
    const error = (text: string) => ('error' in parseRules(text) ? (parseRules(text) as { error: string }).error : undefined);
    expect(error('nope')).toMatch(/^not JSON/);
    expect(error('{}')).toBe('no "rules" list');
    expect(error('{"rules":[{"tools":"change","answer":"yes"}]}')).toBe('rule 1: change needs a "pattern"');
    expect(error('{"rules":[{"tools":"change","pattern":"../*","answer":"yes"}]}')).toMatch(/^rule 1: no "\.\."/);
    expect(error('{"rules":[{"tools":"fs:write","pattern":"*","answer":"yes"}]}')).toBe('rule 1: fs:write rules are under "change"');
    expect(error('{"rules":[{"tools":"app:exec","pattern":"*","answer":"yes"}]}')).toBe('rule 1: app:exec takes no "pattern"');
    expect(error('{"rules":[{"tools":"secret:remove","answer":"yes"}]}')).toBe('rule 1: a secret is always asked');
    expect(error('{"rules":[{"tools":"change","pattern":"*","answer":"maybe"}]}')).toBe('rule 1: "answer" is "yes" or "no"');
  });
});

describe('the rules file', () => {
  let dir: string;
  beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), 'bw-rules-'))));
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('keeps a rule in place of one for the same tools and pattern, and forgets by rule, pattern or tool', async () => {
    const store = new RuleStore(dir);
    expect(await store.load()).toEqual({ rules: [] });
    await store.add({ tools: 'change', pattern: '**/*.js', answer: 'yes' });
    await store.add({ tools: 'change', pattern: '**/*.js', answer: 'no' });
    await store.add({ tools: 'fs:delete', pattern: 'tmp/*', answer: 'yes' });
    await store.add({ tools: 'app:exec', answer: 'yes' });
    expect((await store.load()).rules.map((r) => [r.tools, r.pattern, r.answer])).toEqual([['change', '**/*.js', 'no'], ['fs:delete', 'tmp/*', 'yes'], ['app:exec', undefined, 'yes']]);
    expect((await store.forget('tmp/*')).map((r) => r.tools)).toEqual(['fs:delete']);
    expect((await store.forget('fs:edit')).map((r) => r.pattern)).toEqual(['**/*.js']);
    expect((await store.forget('app:exec')).map((r) => r.tools)).toEqual(['app:exec']);
    expect(JSON.parse(await readFile(join(dir, 'approval-rules.json'), 'utf8'))).toEqual({ rules: [] });
  });

  it('never writes over a file not valid: it is the operator\'s to fix', async () => {
    await writeFile(join(dir, 'approval-rules.json'), '{ oops');
    const store = new RuleStore(dir);
    expect((await store.load()).error).toMatch(/^approval-rules.json: not JSON/);
    await expect(store.add({ tools: 'change', pattern: '**', answer: 'yes' })).rejects.toThrow(/nothing was remembered/);
    expect(await readFile(join(dir, 'approval-rules.json'), 'utf8')).toBe('{ oops');
  });
});

describe('a terminal\'s answer', () => {
  const scopes = scopesFor('fs:edit', 'src/main.js');
  const answering = (...typed: string[]) => {
    const asked: string[] = [];
    return { asked, question: async (prompt: string) => (asked.push(prompt), typed.shift() ?? 'n') };
  };

  it('is yes or no, or remembered for a scope picked by number', async () => {
    expect(await askTerminal(answering('y').question, () => {}, scopes)).toEqual({ verdict: 'yes' });
    expect(await askTerminal(answering('maybe', 'no').question, () => {}, scopes)).toEqual({ verdict: 'no' });
    const shown: string[] = [];
    const t = answering('r', '9', '3', 'y');
    expect(await askTerminal(t.question, (s) => shown.push(s), scopes)).toEqual({ verdict: 'yes', remember: '**/*.js' });
    expect(shown.join('')).toContain('│ 3  every .js file  **/*.js');
    expect(await askTerminal(answering('r', '1', 'n').question, () => {}, scopes)).toEqual({ verdict: 'no', remember: 'src/main.js' });
    // Back out of remembering, then a plain yes.
    expect(await askTerminal(answering('r', '', 'y').question, () => {}, scopes)).toEqual({ verdict: 'yes' });
    // `a`: always, the widest scope.
    expect(await askTerminal(answering('a').question, () => {}, scopes)).toEqual({ verdict: 'yes', remember: '**' });
  });

  it('shows the scopes with the question, and takes y3 / n2 to answer and remember at once', async () => {
    const shown: string[] = [];
    const t = answering('y9', 'y3');
    expect(await askTerminal(t.question, (s) => shown.push(s), scopes)).toEqual({ verdict: 'yes', remember: '**/*.js' });
    expect(shown[0]).toBe('│ remember it for: 1 src/main.js · 2 src/*.js · 3 **/*.js · 4 **\n');
    expect(t.asked[0]).toBe('└ approve? [y]es / [n]o — or y1…y4 / n1…n4 to remember it: ');
    expect(await askTerminal(answering('n 2').question, () => {}, scopes)).toEqual({ verdict: 'no', remember: 'src/*.js' });
  });

  it('offers no remembering for a secret: yes or no', async () => {
    const t = answering('r', 'a', 'y');
    expect(await askTerminal(t.question, () => {}, [])).toEqual({ verdict: 'yes' });
    expect(t.asked[0]).toBe('└ approve? [y]es / [n]o: ');
  });
});
