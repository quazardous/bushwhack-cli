/**
 * The ignore:* tools: the only way the chat changes an ignore file, declaratively and in
 * one direction. An ignore file decides what the chat sees: it may add a rule — hide more,
 * never less — and never remove or change one. The operator edits the files by hand.
 */
import type { Result, ToolSpec } from '@bushwhack/protocol';
import { IGNORE_FILES, Workspace, WorkspaceError } from '@bushwhack/workspace';
import type { ToolRun } from './dispatcher.js';

const file = { type: 'enum', description: 'the ignore file at the project root', values: IGNORE_FILES, default: '.gitignore' } as const;

export const IGNORE_TOOLS: ToolSpec[] = [
  {
    name: 'ignore:list',
    summary: 'The rules of an ignore file at the project root.',
    approval: false,
    params: { file },
  },
  {
    name: 'ignore:add',
    summary: 'Add a rule at the end of an ignore file at the project root, creating the file if it does not exist yet. What it matches disappears from your tools, and from git.',
    approval: true,
    params: {
      file,
      rule: { type: 'text', description: 'one rule, git-style, e.g. node_modules/ or *.log', required: true, maxLength: 200 },
    },
    notes: [
      'A rule only hides more: no negation (`!`), and no rule is ever removed or changed from here — ask me for that.',
      'Ignore files are not written with fs:* tools: this is the way.',
    ],
    example: { args: { file: '.gitignore', rule: 'node_modules/' } },
  },
];

type Outcome = Omit<Result, 'tool' | 'id'>;

export async function runIgnoreTool(workspace: Workspace, call: ToolRun): Promise<Outcome> {
  try {
    const target = workspace.ignoreFile(String(call.args.file ?? '.gitignore'));
    if (call.tool === 'ignore:list') {
      const rules = await target.rules();
      return { status: 'ok', meta: { file: target.rel, rules: rules.length }, content: rules.join('\n') || '(no rule)' };
    }
    const done = await target.add(String(call.args.rule));
    return { status: 'ok', meta: { file: target.rel }, content: done === 'added' ? 'rule added' : 'the rule was already there' };
  } catch (e) {
    if (e instanceof WorkspaceError) return { status: 'error', content: e.message };
    throw e;
  }
}
