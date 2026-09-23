/**
 * The secret:* tools: the only way the chat changes a declared secret file, and never by
 * handling a value. Names in, names out; the values are typed by the operator in the
 * serve terminal and written by the daemon.
 */
import type { Args, Result, ToolSpec } from '@bushwhack/protocol';
import { dotenvValues, NAME_RE, parseDotenv, removeDotenv, setDotenv } from '@bushwhack/secrets';
import { Workspace, WorkspaceError } from '@bushwhack/workspace';
import type { Approver, ToolRun } from './dispatcher.js';

export const SECRET_TOOLS: ToolSpec[] = [
  {
    name: 'secret:list',
    summary: 'List the variables of a declared secret file: names, and whether each is set or empty. Never a value.',
    approval: false,
    params: { file: { type: 'path', description: 'the declared secret file, e.g. app/.env', required: true } },
  },
  {
    name: 'secret:add',
    summary:
      'Add a variable to a declared secret file, or give an existing one a new value. The operator types the value in their terminal; you never see it. Refused if they enter nothing.',
    approval: false,
    params: {
      file: { type: 'path', description: 'the declared secret file', required: true },
      name: { type: 'text', description: 'the variable name, e.g. STRIPE_KEY', required: true, maxLength: 64 },
      description: { type: 'text', description: 'what the value is and where the operator finds it', maxLength: 200 },
    },
  },
  {
    name: 'secret:remove',
    summary: 'Remove a variable from a declared secret file.',
    approval: true,
    params: {
      file: { type: 'path', description: 'the declared secret file', required: true },
      name: { type: 'text', description: 'the variable name', required: true, maxLength: 64 },
    },
  },
];

type Outcome = Omit<Result, 'tool' | 'id'>;

export async function runSecretTool(
  workspace: Workspace,
  approver: Approver,
  call: ToolRun & { id: string; conversation: string },
): Promise<Outcome> {
  const args: Args = call.args;
  try {
    const file = await workspace.secretFile(String(args.file));
    const name = String(args.name ?? '');
    if (call.tool !== 'secret:list' && !NAME_RE.test(name)) {
      return { status: 'error', content: `"${name}" is not a variable name (letters, digits, _; not starting with a digit)` };
    }
    const text = await file.read();

    switch (call.tool) {
      case 'secret:list': {
        const values = dotenvValues(text);
        const names = parseDotenv(text).flatMap((l) => (l.kind === 'var' ? [l.name] : []));
        return {
          status: 'ok',
          meta: { file: file.rel, variables: names.length },
          content: names.map((n) => `${n}  ${values.has(n) ? 'set' : 'empty'}`).join('\n'),
        };
      }
      case 'secret:add': {
        const description = args.description === undefined ? undefined : String(args.description);
        const value = await approver.secretValue({ id: call.id, file: file.rel, name, description });
        if (value === undefined) return { status: 'denied', content: 'the operator gave no value' };
        const existed = dotenvValues(text).has(name) || parseDotenv(text).some((l) => l.kind === 'var' && l.name === name);
        await file.write(setDotenv(text, name, value, description));
        return { status: 'ok', meta: { file: file.rel, name, [existed ? 'replaced' : 'added']: true } };
      }
      case 'secret:remove': {
        const { text: next, removed } = removeDotenv(text, name);
        if (!removed) return { status: 'error', content: `${file.rel} has no variable ${name}` };
        await file.write(next);
        return { status: 'ok', meta: { file: file.rel, removed: name } };
      }
      default:
        return { status: 'error', content: `unknown tool ${call.tool}` };
    }
  } catch (e) {
    if (e instanceof WorkspaceError) return { status: 'error', content: e.message };
    throw e;
  }
}
