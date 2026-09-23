/**
 * Code blocks out of a chat answer's markdown — the text a chat's "copy" button gives,
 * as the model wrote it, before any renderer. Fenced blocks only (``` or ~~~), with the
 * CommonMark rules that matter here: a closing fence uses the same character, is at
 * least as long as the opening one and carries nothing else; an opening fence indented
 * by N spaces takes up to N spaces off each of its lines. An unclosed fence runs to the
 * end — and a call inside it still needs its own end line to count.
 */
export function extractFencedBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let open: { char: string; length: number; indent: number; body: string[] } | null = null;

  for (const line of lines) {
    if (!open) {
      const start = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      // A backtick fence's info string may not contain a backtick.
      if (start && !(start[2][0] === '`' && start[3].includes('`'))) {
        open = { char: start[2][0], length: start[2].length, indent: start[1].length, body: [] };
      }
      continue;
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[1][0] === open.char && close[1].length >= open.length) {
      blocks.push(open.body.join('\n'));
      open = null;
      continue;
    }
    let stripped = line;
    for (let i = 0; i < open.indent && stripped.startsWith(' '); i++) stripped = stripped.slice(1);
    open.body.push(stripped);
  }
  if (open) blocks.push(open.body.join('\n'));
  return blocks;
}
