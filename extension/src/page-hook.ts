/**
 * Runs in the chat page's own world (MAIN), before the page's scripts.
 *
 * A chat's "copy" button puts the model's answer on the clipboard as the markdown the
 * model actually wrote — before any renderer, highlighter or collapsed view touched it.
 * That is the best source for calls there is. This hook lets the content script read it:
 * while the content script has raised a flag on <html>, a clipboard write from the page
 * is captured and handed over instead of reaching the clipboard, so the operator's
 * clipboard is never touched. Without the flag, every write goes through unchanged.
 */
import { answerHookPings } from './hook-presence.js';

const FLAG = 'data-bushwhack-capture';
const EVENT = 'bushwhack:copied';

function capturing(): boolean {
  return document.documentElement.hasAttribute(FLAG);
}

function hand(text: string): void {
  document.documentElement.removeAttribute(FLAG);
  document.dispatchEvent(new CustomEvent(EVENT, { detail: text }));
}

// Older copy code selects a hidden textarea and runs execCommand('copy').
const execCommand = document.execCommand.bind(document);
document.execCommand = (command: string, showUI?: boolean, value?: string): boolean => {
  if (command.toLowerCase() !== 'copy' || !capturing()) return execCommand(command, showUI, value);
  const active = document.activeElement;
  const text = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
    ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? active.value.length)
    : String(window.getSelection() ?? '');
  hand(text);
  return true;
};

answerHookPings(document);

const clipboard = navigator.clipboard;
if (clipboard) {
  const writeText = clipboard.writeText.bind(clipboard);
  const write = clipboard.write.bind(clipboard);
  clipboard.writeText = (text: string): Promise<void> => {
    if (!capturing()) return writeText(text);
    hand(text);
    return Promise.resolve();
  };
  clipboard.write = async (items: ClipboardItems): Promise<void> => {
    if (!capturing()) return write(items);
    for (const item of items) {
      if (item.types.includes('text/plain')) {
        hand(await (await item.getType('text/plain')).text());
        return;
      }
    }
    hand('');
  };
}

