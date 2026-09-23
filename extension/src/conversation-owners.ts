/**
 * One tab acts for a conversation. Two tabs open on the same one would both read its calls
 * and both write results in it — each call run twice, the chat answered twice. The tab that
 * acts is the one last brought to the front among those showing it; until one is, the first
 * to report. The others only say it is handled elsewhere.
 */
export class ConversationOwners {
  /** What each chat tab showed at its last report. */
  private readonly shows = new Map<number, string>();
  private readonly owners = new Map<string, number>();
  /** The tab last brought to the front — a new tab is, before it has reported anything. */
  private front: number | undefined;

  /** A tab reports the conversation it shows. Whether it is the one to act. */
  report(tabId: number, conversation: string | null): boolean {
    const before = this.shows.get(tabId);
    if (before !== undefined && before !== conversation) this.leave(tabId);
    if (conversation === null) return true;
    const arriving = this.shows.get(tabId) !== conversation;
    this.shows.set(tabId, conversation);
    if (!this.owners.has(conversation) || (arriving && tabId === this.front)) this.owners.set(conversation, tabId);
    return this.owners.get(conversation) === tabId;
  }

  /** A tab came to the front: it acts for what it shows. */
  activated(tabId: number): void {
    this.front = tabId;
    const conversation = this.shows.get(tabId);
    if (conversation !== undefined) this.owners.set(conversation, tabId);
  }

  /** A tab closed: another showing its conversation takes over at its next report. */
  forget(tabId: number): void {
    if (this.front === tabId) this.front = undefined;
    this.leave(tabId);
  }

  private leave(tabId: number): void {
    const conversation = this.shows.get(tabId);
    this.shows.delete(tabId);
    if (conversation !== undefined && this.owners.get(conversation) === tabId) this.owners.delete(conversation);
  }

  owner(conversation: string): number | undefined {
    return this.owners.get(conversation);
  }
}
