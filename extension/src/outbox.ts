/**
 * Results waiting to be written, each tied to the conversation its calls came from.
 *
 * Several conversations — several projects — can be open, and a call can wait minutes for
 * approval while the operator moves to another chat. A result is handed out only while
 * its own conversation is the one on screen; any other conversation's results wait.
 */
/** Results as they go into the composer: the text, and the pictures that go with it. */
export interface Delivery {
  text: string;
  images: { name: string; dataUrl: string }[];
}

export class Outbox {
  private waiting = new Map<string, Delivery>();

  hold(conversation: string, delivery: Delivery): void {
    this.waiting.set(conversation, delivery);
  }

  /** The results for the conversation on screen, if any — never another conversation's. */
  deliverable(viewing: string | null): ({ conversation: string } & Delivery) | undefined {
    if (viewing === null) return undefined;
    const delivery = this.waiting.get(viewing);
    return delivery === undefined ? undefined : { conversation: viewing, ...delivery };
  }

  delivered(conversation: string): void {
    this.waiting.delete(conversation);
  }

  /** Conversations with results waiting, for the status bar. */
  get waitingFor(): string[] {
    return [...this.waiting.keys()];
  }
}
