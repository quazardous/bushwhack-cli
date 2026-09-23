/**
 * The `fs:*` tools: their specs (what the manifest shows and the daemon types against)
 * and their handlers (typed args in, a result out). A handler never sees header text,
 * and never throws for a refusal the model should read: a `WorkspaceError` becomes
 * `status: error` with its message.
 */
import type { Args, Result, ToolSpec } from '@bushwhack/protocol';
import { parseEdits, Workspace, WorkspaceError } from './workspace.js';
import { DeclarationError } from '@bushwhack/secrets';

const MB = 1024 * 1024;

export const FS_TOOLS: ToolSpec[] = [
  {
    name: 'fs:list',
    summary: 'List a directory of the project, as an indented tree. Ignored entries are left out and counted.',
    approval: false,
    params: {
      path: { type: 'path', description: 'directory, relative to the project root', default: '.' },
      depth: { type: 'int', description: 'how many levels to descend', min: 1, max: 6, default: 2 },
    },
  },
  {
    name: 'fs:read',
    summary: 'Read a text file, or a range of its lines. The result says which lines you got and how many there are.',
    approval: false,
    params: {
      path: { type: 'path', description: 'the file', required: true },
      from: { type: 'int', description: 'first line, counting from 1', min: 1, max: 10_000_000, default: 1 },
      lines: { type: 'int', description: 'how many lines', min: 1, max: 4000, default: 1000 },
    },
  },
  {
    name: 'fs:search',
    summary: 'Find a literal text in the project\'s files. Answers `path:line: text`, one match per line.',
    approval: false,
    params: {
      text: { type: 'text', description: 'the text to find, literally (not a regex)', required: true, maxLength: 200 },
      path: { type: 'path', description: 'directory or file to search in', default: '.' },
      ignore_case: { type: 'bool', description: 'match regardless of case', default: false },
    },
  },
  {
    name: 'fs:write',
    summary: 'Create a file, or replace it whole. Parent directories are created; the file ends with a newline. Prefer fs:edit for a change to a large file.',
    approval: true,
    params: { path: { type: 'path', description: 'the file', required: true } },
    body: { description: 'the complete new contents of the file', required: true, maxBytes: MB },
  },
  {
    name: 'fs:edit',
    summary:
      'Change part of an existing file. The body holds one or more blocks:\n\n' +
      '    <<<<<<< SEARCH\n    exact existing lines\n    =======\n    their replacement\n    >>>>>>> REPLACE\n\n' +
      'Each SEARCH text must appear exactly once in the file, whitespace included. Blocks apply in order; if one fails, none is saved.',
    approval: true,
    params: { path: { type: 'path', description: 'the file', required: true } },
    body: { description: 'SEARCH/REPLACE blocks', required: true, maxBytes: MB },
    notes: [
      'fs:read the lines first and copy them as they are: indentation, blank lines and trailing spaces count. A SEARCH that is not found saves nothing — re-read, try again.',
      'A SEARCH may span many lines, blank ones included; keep it just long enough to be found once. To change most of a file, fs:write the whole of it instead.',
    ],
    example: {
      args: { path: 'src/server.js' },
      body: "<<<<<<< SEARCH\nfastify.get('/api/health', async () => {\n  return { status: 'ok' };\n});\n\nconst start = async () => {\n=======\nfastify.get('/api/health', async () => {\n  return { status: 'ok', time: new Date().toISOString() };\n});\n\nconst start = async () => {\n>>>>>>> REPLACE",
    },
  },
  {
    name: 'fs:move',
    summary: 'Move or rename a file. The destination must not exist. Directories are not moved.',
    approval: true,
    params: {
      from: { type: 'path', description: 'the file to move', required: true },
      to: { type: 'path', description: 'its new path', required: true },
    },
  },
  {
    name: 'fs:delete',
    summary: 'Delete a file, or an empty directory.',
    approval: true,
    params: { path: { type: 'path', description: 'what to delete', required: true } },
  },
];

type Outcome = Omit<Result, 'tool' | 'id'>;

const str = (value: Args[string]): string => String(value);
const num = (value: Args[string]): number => Number(value);

export async function runFsTool(workspace: Workspace, tool: string, args: Args, body: string | null): Promise<Outcome> {
  try {
    switch (tool) {
      case 'fs:list': {
        const r = await workspace.list(str(args.path), num(args.depth));
        return {
          status: 'ok',
          meta: { entries: r.entries, ...(r.hidden ? { ignored: r.hidden } : {}), ...(r.truncated ? { truncated: true } : {}) },
          content: r.text,
        };
      }
      case 'fs:read': {
        const r = await workspace.read(str(args.path), num(args.from), num(args.lines));
        return { status: 'ok', meta: { path: str(args.path), lines: r.range, ...(r.truncated ? { truncated: true } : {}) }, content: r.text };
      }
      case 'fs:search': {
        const r = await workspace.search(str(args.text), str(args.path), args.ignore_case === true);
        return { status: 'ok', meta: { matches: r.matches, ...(r.truncated ? { truncated: true } : {}) }, content: r.text };
      }
      case 'fs:write': {
        // The call grammar cannot end a body with a newline (the end line follows the
        // last line); text files end with one, so a non-empty body gets it here.
        const content = body === null || body === '' || body.endsWith('\n') ? (body ?? '') : `${body}\n`;
        const r = await workspace.write(str(args.path), content);
        return { status: 'ok', meta: { path: r.rel, bytes: r.bytes, created: r.created } };
      }
      case 'fs:edit': {
        const r = await workspace.edit(str(args.path), parseEdits(body ?? ''));
        return { status: 'ok', meta: { path: r.rel, edits: r.applied } };
      }
      case 'fs:move': {
        const r = await workspace.move(str(args.from), str(args.to));
        return { status: 'ok', meta: { from: r.from, to: r.to } };
      }
      case 'fs:delete': {
        const r = await workspace.delete(str(args.path));
        return { status: 'ok', meta: { path: r.rel, deleted: r.kind } };
      }
      default:
        return { status: 'error', content: `unknown tool ${tool}` };
    }
  } catch (e) {
    if (e instanceof WorkspaceError) return { status: 'error', content: e.message };
    if (e instanceof DeclarationError) return { status: 'error', content: `the operator's secret-file declarations are invalid (${e.message}); ask them to fix it` };
    throw e;
  }
}
