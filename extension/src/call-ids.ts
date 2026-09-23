/**
 * The first `c<n>` id no call of a conversation has used, from its handled calls' keys
 * (`<id>:<hash>`). Ids the model chose otherwise do not count: they cannot collide with
 * the numbering it is told to go on with.
 */
export function nextCallId(handled: string[]): number {
  return handled.reduce((next, key) => {
    const n = /^c(\d+):/.exec(key);
    return n ? Math.max(next, Number(n[1]) + 1) : next;
  }, 1);
}
