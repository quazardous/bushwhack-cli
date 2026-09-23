/**
 * Approvals in the browser, when no terminal takes them: the service asks the worker, the
 * worker shows a notification (Yes / No) and keeps the request until it is answered — by
 * a click on the notification's buttons, or on the approval page (approve.html) that a
 * click on the notification opens, with the whole diff and what to remember the answer for.
 *
 * Never from the panel: it opens framed over the chat page, where the page could lure a
 * click. approve.html is not web-accessible — no site can frame it — and opens in a
 * window of its own.
 */
import type { ApprovalRequest, ApprovalVerdict } from '@bushwhack/protocol';

export interface PendingApproval extends ApprovalRequest {
  /** Which service asked: its relay's port. */
  port: number;
  /** The request's envelope: the reply names it. */
  envelopeId: string;
  at: number;
}

/** A request's key — the notification's id, the approval page's `?key=`. */
export function approvalKey(p: { port: number; project: string; id: string }): string {
  return `${p.port}|${p.project}|${p.id}`;
}

export const VERDICTS: readonly ApprovalVerdict[] = ['yes', 'no'];

export function isApprovalRequest(payload: unknown): payload is ApprovalRequest {
  const p = payload as Partial<ApprovalRequest> | null;
  return (
    !!p &&
    typeof p.project === 'string' &&
    typeof p.id === 'string' &&
    typeof p.tool === 'string' &&
    typeof p.text === 'string' &&
    (p.path === undefined || typeof p.path === 'string') &&
    (p.scopes === undefined || (Array.isArray(p.scopes) && p.scopes.every((s) => typeof s?.label === 'string' && (s.pattern === undefined || typeof s.pattern === 'string')))) &&
    (p.preset === undefined || (Number.isInteger(p.preset) && p.preset >= 0 && p.preset < (p.scopes?.length ?? 0)))
  );
}

/** What a request does, in one line: the file and how much changes, or its first line. */
export function summary(p: ApprovalRequest): string {
  const lines = p.text.split('\n');
  const where = p.path ?? '';
  if (lines[0].startsWith('new file ')) return `${where || lines[0].slice(9)}: new file, ${lines.length - 1} line${lines.length === 2 ? '' : 's'}`;
  if (lines.some((l) => l.startsWith('@@'))) {
    const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    return `${where}: +${added} −${removed}`;
  }
  const first = lines[0].length > 120 ? `${lines[0].slice(0, 119)}…` : lines[0];
  return where && !first.includes(where) ? `${where}: ${first}` : first;
}

/** The notification: who asks what, and the one line. */
export function notificationOf(p: ApprovalRequest): { title: string; message: string } {
  return { title: `${p.project} · ${p.id} ${p.tool}`, message: summary(p) };
}

/** The badge: how many wait, nothing when none. */
export function badgeOf(count: number): string {
  return count === 0 ? '' : count > 99 ? '99+' : String(count);
}
