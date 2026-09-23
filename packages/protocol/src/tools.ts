/**
 * Tool specs: the `tools/list` half of the pseudo-MCP.
 *
 * A spec is data — name, what it does, typed parameters, whether it takes a body and
 * whether the operator must approve it. The daemon renders the manifest from these specs
 * and types every call against them before a handler sees it, so a handler receives
 * values, never header text.
 *
 * Parameter types are narrow on purpose, like the catalogue's: a `path` is checked for
 * shape here and for the jail by the workspace; `text` is one bounded line. There is no
 * free-form object.
 */

export type ParamSpec =
  | { type: 'path'; description: string; required?: boolean; default?: string }
  | { type: 'text'; description: string; required?: boolean; default?: string; maxLength: number }
  | { type: 'int'; description: string; required?: boolean; default?: number; min: number; max: number }
  | { type: 'bool'; description: string; default?: boolean }
  | { type: 'enum'; description: string; values: readonly string[]; default?: string };

export interface BodySpec {
  description: string;
  required: boolean;
  maxBytes: number;
}

export interface ToolSpec {
  /** `<family>:<action>`, as the model writes it after `bushwhack:`. */
  name: string;
  summary: string;
  params: Record<string, ParamSpec>;
  body?: BodySpec;
  /** Stops at the terminal prompt before running. */
  approval: boolean;
  /** How to use it well, one rule a line: rendered under its parameters. */
  notes?: string[];
  /** A whole call, rendered as the model should write one. Must be a valid call of this tool. */
  example?: { args: Record<string, string>; body?: string };
}

export type ArgValue = string | number | boolean;
export type Args = Record<string, ArgValue | undefined>;

export interface Bound {
  args: Args;
  body: string | null;
}

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgsError';
  }
}

const MAX_PATH = 1024;

function bindOne(name: string, spec: ParamSpec, raw: string | undefined): ArgValue | undefined {
  if (raw === undefined) {
    if ('required' in spec && spec.required) throw new ArgsError(`"${name}" is required`);
    return spec.default;
  }
  switch (spec.type) {
    case 'path':
      if (raw === '' || raw.length > MAX_PATH || raw.includes('\0')) {
        throw new ArgsError(`"${name}" must be a non-empty path of at most ${MAX_PATH} characters`);
      }
      return raw;
    case 'text':
      if (raw.length > spec.maxLength || raw.includes('\n')) {
        throw new ArgsError(`"${name}" must be one line of at most ${spec.maxLength} characters`);
      }
      return raw;
    case 'int': {
      if (!/^-?\d+$/.test(raw)) throw new ArgsError(`"${name}" must be an integer`);
      const value = Number(raw);
      if (value < spec.min || value > spec.max) {
        throw new ArgsError(`"${name}" must be between ${spec.min} and ${spec.max}`);
      }
      return value;
    }
    case 'bool':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new ArgsError(`"${name}" must be true or false`);
    case 'enum':
      if (!spec.values.includes(raw)) throw new ArgsError(`"${name}" must be one of: ${spec.values.join(', ')}`);
      return raw;
  }
}

/** Type a call's header and body against its spec. Unknown keys are refused, not ignored. */
export function bindArgs(spec: ToolSpec, raw: Record<string, string>, body: string | null): Bound {
  const unknown = Object.keys(raw).filter((key) => !(key in spec.params));
  if (unknown.length > 0) {
    const known = Object.keys(spec.params);
    throw new ArgsError(
      `unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}` +
        ` — ${spec.name} takes ${known.length ? known.join(', ') : 'none'}` +
        // A text put in a header key is the likeliest mistake for a tool with a body.
        (spec.body ? `, and a body (${spec.body.description}): after a second --- line, up to ---end` : ''),
    );
  }

  const args: Args = {};
  for (const [name, param] of Object.entries(spec.params)) args[name] = bindOne(name, param, raw[name]);

  if (!spec.body) {
    if (body !== null && body.trim() !== '') throw new ArgsError(`${spec.name} takes no body`);
    return { args, body: null };
  }
  if (body === null) {
    if (spec.body.required) throw new ArgsError(`${spec.name} needs a body (${spec.body.description}): after the header, a second --- line, then the text, up to ---end`);
    return { args, body: null };
  }
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > spec.body.maxBytes) {
    throw new ArgsError(`the body is ${bytes} bytes; ${spec.name} takes at most ${spec.body.maxBytes}`);
  }
  return { args, body };
}
