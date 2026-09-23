/**
 * Is the page hook there? The content script clicks a chat's copy button only when the
 * hook will catch the clipboard write — otherwise the click reaches the operator's real
 * clipboard. Pages loaded before the extension have no hook. Events dispatched on the
 * document reach both worlds synchronously, so the answer is immediate.
 */
const PING = 'bushwhack:hook-ping';
const PONG = 'bushwhack:hook-pong';

/** In the page hook: answer every ping. */
export function answerHookPings(doc: Document): void {
  doc.addEventListener(PING, () => doc.dispatchEvent(new Event(PONG)));
}

/** In the content script: whether a hook answered. */
export function hookPresent(doc: Document): boolean {
  let present = false;
  const pong = (): void => {
    present = true;
  };
  doc.addEventListener(PONG, pong);
  doc.dispatchEvent(new Event(PING));
  doc.removeEventListener(PONG, pong);
  return present;
}
