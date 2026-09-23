/**
 * The manifest: `tools/list`, rendered as the message that teaches a chat model the
 * protocol. It is written into the composer once, at the start of a conversation, by the
 * operator — the model has no other way to learn what it can call.
 *
 * Rendered from the specs, never written by hand, so the text the model reads cannot
 * drift from what the daemon accepts.
 */
import { CALL_KEY, END_LINE } from './grammar.js';
import type { ParamSpec, ToolSpec } from './tools.js';

function describeParam(name: string, param: ParamSpec): string {
  const bits: string[] = [];
  switch (param.type) {
    case 'path': bits.push('path'); break;
    case 'text': bits.push(`text, one line, ≤${param.maxLength} chars`); break;
    case 'int': bits.push(`integer ${param.min}–${param.max}`); break;
    case 'bool': bits.push('true | false'); break;
    case 'enum': bits.push(param.values.join(' | ')); break;
  }
  if ('required' in param && param.required) bits.push('required');
  else if (param.default !== undefined) bits.push(`default ${param.default}`);
  else bits.push('optional');
  return `  - \`${name}\` (${bits.join(', ')}): ${param.description}`;
}

/** A tool's example as the model writes a call: the lines inside the `bushwhack` block. */
export function exampleCall(spec: ToolSpec, id = 'c9'): string | undefined {
  if (!spec.example) return undefined;
  const { args, body } = spec.example;
  return ['---', `${CALL_KEY}: ${spec.name}`, `id: ${id}`, ...Object.entries(args).map(([k, v]) => `${k}: ${v}`), ...(body !== undefined ? ['---', body] : []), END_LINE].join('\n');
}

function describeTool(spec: ToolSpec): string {
  const out = [`### \`${spec.name}\`${spec.approval ? ' — needs the operator\'s approval' : ''}`, '', spec.summary];
  const params = Object.entries(spec.params);
  if (params.length > 0) out.push('', ...params.map(([name, param]) => describeParam(name, param)));
  if (spec.body) {
    out.push(`  - body (${spec.body.required ? 'required' : 'optional'}, ≤${spec.body.maxBytes} bytes): ${spec.body.description}`);
  }
  if (spec.notes?.length) out.push('', ...spec.notes.map((note) => `- ${note}`));
  const example = exampleCall(spec);
  if (example) out.push('', 'For example:', '', '````', '```bushwhack', example, '```', '````');
  return out.join('\n');
}

/**
 * What a chat driver adds to the manifest: how to behave in *that* chat. Each UI renders
 * code, cuts long answers and tempts its model differently; the tools do not change, the
 * advice does. Written and tested per driver, against the live chat.
 */
export interface ChatPrompt {
  /** The chat's name, as the model knows it. */
  title: string;
  /** One paragraph on where the model is and what reads its answers. */
  preamble: string;
  /** Rules that matter in this chat, one line each, most important first. */
  notes: string[];
}

export const CHAT_PROMPT_LIMITS = { title: 80, preamble: 1200, note: 400, notes: 20 } as const;

export interface ManifestContext {
  /** The session's name, so the model can say which project it is working on. */
  session: string;
  chat?: ChatPrompt;
}

export function renderManifest(specs: ToolSpec[], context: ManifestContext): string {
  const fence = '````';
  return [
    `# bushwhack — tools for project "${context.session}"`,
    '',
    'You can act on a project folder on my machine. You do it by writing **tool calls** in',
    'your answer; a bridge in my browser runs them and pastes the results as my next message.',
    '',
    ...(context.chat ? [context.chat.preamble, ''] : []),
    '## How to call a tool',
    '',
    'Write each call as its own fenced code block, exactly in this shape:',
    '',
    `${fence}`,
    '```bushwhack',
    '---',
    `${CALL_KEY}: fs:read`,
    'id: c1',
    'path: README.md',
    END_LINE,
    '```',
    `${fence}`,
    '',
    'A tool that takes a body (file contents) gets a second `---` line; everything after it,',
    `up to the \`${END_LINE}\` line, is the body, raw — no escaping, no indentation:`,
    '',
    `${fence}`,
    '```bushwhack',
    '---',
    `${CALL_KEY}: fs:write`,
    'id: c2',
    'path: src/hello.js',
    '---',
    "console.log('hello');",
    END_LINE,
    '```',
    `${fence}`,
    '',
    'Rules:',
    '',
    `- The block must end with the line \`${END_LINE}\`. A call without it is never run.`,
    '- `id` is yours to choose (letters, digits, `_`, `-`) and must be **new each time** in this conversation: c1, c2, c3…',
    '- One `key: value` per line. Put a value in double quotes, JSON-style, if it starts or ends with spaces or holds a `"`.',
    '- A header is one line. A text of several lines is never a header (no `content: |`, no YAML block): it is the body.',
    '- If the body itself contains a line of three backticks, fence the call with four or more.',
    '- You may put several calls in one answer; they run in order. Then **stop and wait**: the results come in my next',
    '  message, as `bushwhack-result` blocks with the same ids. Never write a result yourself, never guess one.',
    '- Paths are relative to the project root (the app, if any, sees the project at /app: that path is not for these',
    '  tools). Ignored files (`.gitignore`, `.bushwhackignore`) and `.git/` do not',
    '  exist for these tools. Ignore files change only through `ignore:add`: rules added, never removed.',
    '- Some tools need my approval in my terminal. `status: denied` means I said no — ask me, do not retry blindly.',
    '- When I say no to a call, the calls after it in the same answer are not run (`status: skipped`): they may have depended on it. Send again, in a new answer, those that still make sense.',
    '- If bushwhack itself seems wrong — a tool misbehaving, a result that contradicts the files — or could serve you',
    '  better — something unclear here, a tool you miss, a step that costs you time — say so with `report:bug`',
    '  (kind: bug or suggestion; see it below), then carry on.',
    '- Some files are secret files: you see their values as `‹secret:NAME›`, and you change them only with the `secret:*`',
    '  tools — I type the values in my terminal. A `‹secret:NAME›` anywhere else is a value masked for the same reason.',
    '',
    ...(context.chat && context.chat.notes.length > 0
      ? [`## In ${context.chat.title}`, '', ...context.chat.notes.map((note) => `- ${note}`), '']
      : []),
    '## Tools',
    '',
    specs.map(describeTool).join('\n\n'),
    '',
    'Start with `fs:list` to see the project.',
  ].join('\n');
}
