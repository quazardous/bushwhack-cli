/**
 * How a chat page came to show its conversation: born here, or reached by navigating.
 *
 * A chat bound before its first message is bound by tab; the conversation it becomes
 * inherits the binding. Only the one born in that tab may: navigating from the fresh
 * chat to an old conversation (the sidebar) must not hand that conversation to the
 * project — its old calls would be taken for new ones.
 *
 * Born: while the page had no conversation id, a message was on its way — text in the
 * message box, a prompt sent from the terminal, or an answer appearing — and the
 * conversation it lands on is at most one exchange long.
 */
export interface PageView {
  /** Whether the message box holds text. */
  composing: boolean;
  /** The model's answers the page shows. */
  answers: number;
}

export class Arrival {
  private last: string | null | undefined;
  private fresh: { composing: boolean; answers: number; grew: boolean } | undefined;
  private born: string | undefined;

  /** A prompt from the terminal was sent from this page. */
  sent(): void {
    if (this.fresh) this.fresh.composing = true;
  }

  /** What the page shows now; whether its conversation was born here. */
  observe(conversation: string | null, view: PageView): boolean {
    if (conversation === null) {
      if (this.last !== null) this.fresh = { composing: false, answers: view.answers, grew: false };
      const fresh = this.fresh!;
      fresh.composing ||= view.composing;
      fresh.grew ||= view.answers > fresh.answers;
    } else if (conversation !== this.last) {
      const fresh = this.last === null ? this.fresh : undefined;
      this.born = fresh && (fresh.grew || (fresh.composing && view.answers <= 1)) ? conversation : undefined;
      this.fresh = undefined;
    }
    this.last = conversation;
    return conversation !== null && conversation === this.born;
  }
}
