/**
 * Knows when a person is using the page.
 *
 * The bridge writes into the same message box the operator types in. Anything it writes
 * or sends while they type would mix their words with results, or send half a sentence.
 * The browser tells the two apart for us: events from a person are `isTrusted`, the
 * bridge's own synthetic paste and click are not.
 */
export const QUIET_MS = 4000;

const HUMAN_EVENTS = ['keydown', 'beforeinput', 'paste', 'drop', 'compositionstart'] as const;

export class HumanGuard {
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now) {}

  /** Listen on a document, in the capture phase so the page cannot swallow the events first. */
  watch(doc: Document): void {
    for (const type of HUMAN_EVENTS) {
      doc.addEventListener(type, (event) => {
        if (event.isTrusted) this.note();
      }, true);
    }
  }

  /** A person just did something. */
  note(): void {
    this.last = this.now();
  }

  /** Whether a person typed within the last few seconds: writing now would collide. */
  typing(): boolean {
    return this.now() - this.last < QUIET_MS;
  }

  /** Whether a person touched the page after `time` — e.g. after results were written. */
  touchedSince(time: number): boolean {
    return this.last >= time;
  }
}
