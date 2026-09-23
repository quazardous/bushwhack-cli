/**
 * The call grammar: what the model writes in the chat, and what it reads back.
 *
 * A call is a fenced code block whose text is frontmatter, an optional raw body, and an
 * end line:
 *
 *     ---
 *     bushwhack: fs:write
 *     id: c3
 *     path: src/app.js
 *     ---
 *     console.log('hello');
 *     ---end
 *
 * Why not JSON: the body is where file contents go, and a model escaping a 300-line file
 * into a JSON string is where web-chat tool calls break. Here the body is raw — nothing to
 * escape, nothing to get wrong.
 *
 * Why `---end`: a chat streams its answer, and a half-streamed body parses perfectly well
 * — as a truncated file. The end line is the only signal, independent of any chat UI,
 * that the model has finished writing the call. No end line, no call.
 *
 * The header is a deliberately tiny subset of YAML: one `key: value` per line, values are
 * raw text or a JSON string when they need quoting. No nesting, no lists, no anchors —
 * nothing a value can smuggle.
 */

export const CALL_KEY = 'bushwhack';
export const RESULT_KEY = 'bushwhack-result';
export const END_LINE = '---end';
const FENCE_LINE = '---';

const KEY_RE = /^([a-z][a-z0-9_-]*):(?:[ \t]+(.*))?$/;
const TOOL_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
export const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export interface Call {
  tool: string;
  id: string;
  /** Header values, still text: typing them is the tool spec's job. */
  args: Record<string, string>;
  /** Raw text between the header and the end line, or null when there was no body. */
  body: string | null;
}

export type ScanResult =
  | { kind: 'call'; call: Call }
  /** Ours, but still streaming: look again later. */
  | { kind: 'incomplete' }
  /** Ours and finished, but malformed: worth telling the model why. */
  | { kind: 'invalid'; id: string | null; error: string };

function lines(text: string): string[] {
  const all = text.replace(/\r\n?/g, '\n').split('\n');
  while (all.length > 0 && all[0].trim() === '') all.shift();
  while (all.length > 0 && all[all.length - 1].trim() === '') all.pop();
  return all;
}

function headerValue(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value.startsWith('"')) return value;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'string') throw new Error('a quoted value must be a JSON string');
  return parsed;
}

/**
 * Read a code block's text. Returns undefined when the block is not a bushwhack call at
 * all — any other code in the chat, including result blocks.
 */
export function scanCall(text: string, marker: string = CALL_KEY): ScanResult | undefined {
  const all = lines(text);
  if (all[0]?.trim() !== FENCE_LINE) return undefined;
  const first = KEY_RE.exec(all[1] ?? '');
  if (!first || first[1] !== marker) return undefined;

  if (all[all.length - 1].trim() !== END_LINE || all.length < 3) return { kind: 'incomplete' };

  const tool = (first[2] ?? '').trim();
  const args: Record<string, string> = {};
  let id: string | null = null;
  let i = 2;
  let body: string | null = null;

  const invalid = (error: string): ScanResult => ({ kind: 'invalid', id, error });

  for (; i < all.length; i++) {
    const line = all[i];
    if (line.trim() === FENCE_LINE || line.trim() === END_LINE) break;
    if (line.trim() === '') continue;
    const match = KEY_RE.exec(line);
    if (!match) {
      // A text of several lines written as a YAML block (`content: |`, then indented lines):
      // the model guessed a format; say the one there is.
      const block = i > 2 && /:\s*[|>][-+]?\s*$/.test(all[i - 1]);
      return invalid(
        block || /^\s/.test(line)
          ? `header line ${i + 1} is not "key: value" — a header is one line. A text of several lines (a file's contents) is the body: after the headers, a line ${FENCE_LINE}, then the text as is, not indented — not a "content: |" header`
          : `header line ${i + 1} is not "key: value": ${line.slice(0, 60)}`,
      );
    }
    const [, key, raw] = match;
    let value: string;
    try {
      value = headerValue(raw);
    } catch (e) {
      return invalid(`"${key}": ${(e as Error).message}`);
    }
    if (key === 'id') {
      if (id !== null) return invalid('"id" is given twice');
      id = value;
      continue;
    }
    if (key in args) return invalid(`"${key}" is given twice`);
    args[key] = value;
  }

  if (id === null) return invalid('every call needs an "id"');
  if (!ID_RE.test(id)) {
    const bad = id;
    id = null;
    return invalid(`id "${bad.slice(0, 50)}" must be 1-40 of A-Z a-z 0-9 _ -`);
  }
  if (!TOOL_RE.test(tool)) return invalid(`"${tool.slice(0, 50)}" is not a tool name`);

  if (all[i].trim() === END_LINE) {
    if (i !== all.length - 1) return invalid(`"${END_LINE}" ends the call; nothing may follow it`);
  } else {
    body = all.slice(i + 1, all.length - 1).join('\n');
  }

  return { kind: 'call', call: { tool, id, args, body } };
}

/** `skipped`: not run, because a call before it in the same answer was denied. */
export type Status = 'ok' | 'error' | 'denied' | 'skipped';

export interface Result {
  tool: string;
  /** The call's id, or null when the call was too broken to have one. */
  id: string | null;
  status: Status;
  /** Short facts about the result, rendered as header lines. */
  meta?: Record<string, string | number | boolean>;
  /** The payload: file text, a listing, an error message. */
  content?: string;
}

function renderValue(value: string | number | boolean): string {
  const text = String(value);
  // Quote anything that would not read back as itself.
  return /^[^\s"][^\n]*[^\s]$|^[^\s"]$/.test(text) ? text : JSON.stringify(text);
}

function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * A result, in the same shape as a call and fenced so the chat shows it as code. The
 * fence is longer than any backtick run in the content, so a file holding markdown
 * cannot close it early.
 */
export function formatResult(result: Result): string {
  const header = [FENCE_LINE, `${RESULT_KEY}: ${result.tool}`];
  if (result.id !== null) header.push(`id: ${result.id}`);
  header.push(`status: ${result.status}`);
  for (const [key, value] of Object.entries(result.meta ?? {})) header.push(`${key}: ${renderValue(value)}`);

  const content = result.content ?? '';
  const block = content === ''
    ? [...header, END_LINE].join('\n')
    : [...header, FENCE_LINE, content, END_LINE].join('\n');
  const fence = fenceFor(block);
  return `${fence}bushwhack-result\n${block}\n${fence}`;
}

/** Several results as one chat message, in call order. */
export function formatResults(results: Result[]): string {
  return results.map(formatResult).join('\n\n');
}
