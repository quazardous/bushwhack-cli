/**
 * dotenv, as a secret-file format: parsed line by line so that comments, blank lines and
 * order survive a rewrite, values scrambled for the chat, variables added and removed by
 * the daemon only.
 *
 * Value syntax is the common one: `KEY=value`, optionally `export KEY=value`; a value in
 * double quotes may hold `\n`, `\"` and `\\` escapes, one in single quotes is literal;
 * an unquoted value ends at ` #` (an inline comment) and is trimmed.
 */

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type Line =
  | { kind: 'other'; raw: string }
  | { kind: 'var'; raw: string; name: string; value: string; exported: boolean };

const VAR_RE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function parseValue(rest: string): string {
  const text = rest.trimStart();
  if (text.startsWith('"')) {
    let out = '';
    for (let i = 1; i < text.length; i++) {
      const c = text[i];
      if (c === '\\' && i + 1 < text.length) {
        const n = text[++i];
        out += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n;
      } else if (c === '"') {
        return out;
      } else {
        out += c;
      }
    }
    return out;
  }
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    return end < 0 ? text.slice(1) : text.slice(1, end);
  }
  const comment = text.search(/\s#/);
  return (comment < 0 ? text : text.slice(0, comment)).trim();
}

export function parseDotenv(text: string): Line[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((raw) => {
    const match = VAR_RE.exec(raw);
    if (!match || raw.trimStart().startsWith('#')) return { kind: 'other', raw };
    return { kind: 'var', raw, name: match[3], value: parseValue(match[4]), exported: Boolean(match[2]) };
  });
}

export function placeholder(name: string): string {
  return `‹secret:${name}›`;
}

/** What the chat sees: every line as written, every non-empty value replaced by its name. */
export function scrambleDotenv(text: string): string {
  const out = parseDotenv(text).map((line) => {
    if (line.kind === 'other') return line.raw;
    return `${line.exported ? 'export ' : ''}${line.name}=${line.value === '' ? '' : placeholder(line.name)}`;
  });
  return out.length === 0 ? '' : out.join('\n') + '\n';
}

/** The values, by name, for masking them anywhere else they might show up. */
export function dotenvValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of parseDotenv(text)) if (line.kind === 'var' && line.value !== '') values.set(line.name, line.value);
  return values;
}

function quote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

function render(lines: Line[]): string {
  return lines.length === 0 ? '' : lines.map((l) => l.raw).join('\n') + '\n';
}

/** Set a variable: replace its value where it is, or append it — with a comment above when given. */
export function setDotenv(text: string, name: string, value: string, comment?: string): string {
  if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a variable name`);
  const lines = parseDotenv(text);
  const raw = `${name}=${quote(value)}`;
  const at = lines.findIndex((l) => l.kind === 'var' && l.name === name);
  if (at >= 0) {
    const old = lines[at] as Extract<Line, { kind: 'var' }>;
    lines[at] = { ...old, value, raw: `${old.exported ? 'export ' : ''}${raw}` };
  } else {
    if (comment) lines.push({ kind: 'other', raw: `# ${comment.replace(/\s+/g, ' ').trim()}` });
    lines.push({ kind: 'var', raw, name, value, exported: false });
  }
  return render(lines);
}

/** Remove a variable; false when it was not there. */
export function removeDotenv(text: string, name: string): { text: string; removed: boolean } {
  const lines = parseDotenv(text);
  const kept = lines.filter((l) => !(l.kind === 'var' && l.name === name));
  return { text: render(kept), removed: kept.length !== lines.length };
}
