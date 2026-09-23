/**
 * The panel over the chat: the whole page, with a × to close it (or Escape). It frames the
 * panel page — an extension page at a per-session address — so the chat's own scripts can
 * neither read it (a pairing code typed there stays there) nor frame it themselves. What
 * is drawn here, in a closed shadow root, is only the frame and the ×.
 */
export const PANEL_CLOSE = 'bushwhack:panel-close';

const STYLE = `
  :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: Canvas; color-scheme: light dark; }
  button {
    position: absolute; top: 10px; right: 14px; width: 34px; height: 34px; border-radius: 50%;
    border: 1px solid #9ca3af; background: Canvas; color: CanvasText; color-scheme: light dark;
    font: 20px/1 system-ui, sans-serif; cursor: pointer;
  }
  button:hover { background: #dc2626; border-color: #dc2626; color: #fff; }
`;

export class PanelOverlay {
  private host: HTMLElement | undefined;
  private frame: HTMLIFrameElement | undefined;

  constructor(private readonly doc: Document) {}

  get open(): boolean {
    return this.host !== undefined;
  }

  /** Open it on `src` (the panel page), or close it when open. */
  toggle(src: string): void {
    if (this.host) this.close();
    else this.show(src);
  }

  close(): void {
    this.host?.remove();
    this.host = undefined;
    this.frame = undefined;
    this.doc.removeEventListener('keydown', this.onKey, true);
    this.doc.defaultView?.removeEventListener('message', this.onMessage);
  }

  private show(src: string): void {
    const host = this.doc.createElement('bushwhack-panel');
    const root = host.attachShadow({ mode: 'closed' });
    const style = this.doc.createElement('style');
    style.textContent = STYLE;
    const frame = this.doc.createElement('iframe');
    frame.src = src;
    frame.title = 'bushwhack';
    const close = this.doc.createElement('button');
    close.textContent = '×';
    close.title = 'Close (Esc)';
    close.onclick = () => this.close();
    root.append(style, frame, close);
    this.doc.documentElement.append(host);
    this.host = host;
    this.frame = frame;
    // Escape in the page closes it; inside the panel, the panel says so.
    this.doc.addEventListener('keydown', this.onKey, true);
    this.doc.defaultView?.addEventListener('message', this.onMessage);
    frame.focus();
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.close();
  };

  /** Only the panel's own frame may close it — not a message from the page. */
  private readonly onMessage = (e: MessageEvent): void => {
    if (this.frame && e.source === this.frame.contentWindow && e.data === PANEL_CLOSE) this.close();
  };
}
