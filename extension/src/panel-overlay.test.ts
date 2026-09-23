// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { PANEL_CLOSE, PanelOverlay } from './panel-overlay.js';

const SRC = 'chrome-extension://d1a2b3/popup.html?tab=3';

describe('the panel over the chat', () => {
  it('opens over the whole page, and closes on its ×, on Escape, or on a second click of the icon', () => {
    const overlay = new PanelOverlay(document);
    overlay.toggle(SRC);
    expect(overlay.open).toBe(true);
    expect(document.querySelectorAll('bushwhack-panel')).toHaveLength(1);
    overlay.toggle(SRC);
    expect(overlay.open).toBe(false);
    expect(document.querySelector('bushwhack-panel')).toBeNull();

    overlay.toggle(SRC);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(overlay.open).toBe(false);
  });

  it('closes when its own frame asks, and not when the page does', () => {
    const overlay = new PanelOverlay(document);
    overlay.toggle(SRC);
    // The page posting the same message: ignored.
    window.dispatchEvent(new MessageEvent('message', { data: PANEL_CLOSE, source: window }));
    expect(overlay.open).toBe(true);
    const frame = (overlay as unknown as { frame: HTMLIFrameElement }).frame;
    window.dispatchEvent(new MessageEvent('message', { data: PANEL_CLOSE, source: frame.contentWindow }));
    expect(overlay.open).toBe(false);
  });
});
