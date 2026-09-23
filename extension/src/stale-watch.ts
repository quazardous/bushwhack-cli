/**
 * An answer the chat finished but never showed: ChatGPT left one empty on screen — its
 * action bar there, its message blank — until the page was reloaded, and the calls in it
 * waited unread. Seen long enough, it is worth one reload; never twice in a row, so a page
 * that stays blank is not reloaded in a loop.
 */
export interface Stamp {
  get(): number | undefined;
  set(at: number): void;
}

export class StaleWatch {
  private since: number | undefined;

  constructor(
    /** When the page was last reloaded for this: kept across the reload. */
    private readonly lastReload: Stamp,
    private readonly waitMs = 20_000,
    private readonly repeatMs = 120_000,
  ) {}

  /** Whether to reload now, given whether the latest answer is blank at `now`. */
  observe(blank: boolean, now: number): boolean {
    if (!blank) {
      this.since = undefined;
      return false;
    }
    this.since ??= now;
    if (now - this.since < this.waitMs) return false;
    const last = this.lastReload.get();
    if (last !== undefined && now - last < this.repeatMs) return false;
    this.lastReload.set(now);
    return true;
  }
}
