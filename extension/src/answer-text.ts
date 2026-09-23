/**
 * Remove a call block with the frame the chat draws around it — a header naming its
 * language (`bushwhack`), a copy button: every ancestor whose only other text is that
 * name. The terminal shows calls on their own lines; their frames would be left as a
 * stray "bushwhack" line each.
 */
export function removeWithFrame(root: Element, block: Element): void {
  const own = block.textContent ?? '';
  let node = block;
  while (node.parentElement && node.parentElement !== root) {
    const rest = (node.parentElement.textContent ?? '').replace(own, '').trim();
    if (!/^(bushwhack)?$/i.test(rest)) break;
    node = node.parentElement;
  }
  node.remove();
}

/**
 * A code block that is a call — or will be: a chat may say its answer is written while a
 * block is still empty, or holds only the call's first lines, its frame already drawn.
 */
export function isCallBlock(text: string): boolean {
  const t = text.trim();
  return t === '' || t.includes('bushwhack:') || /^-{3}\s*$/.test(t);
}
