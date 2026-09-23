/**
 * Approvals in the browser: what the notification says of a call, and which requests the
 * worker takes at all.
 */
import { describe, it, expect } from 'vitest';
import { approvalKey, badgeOf, isApprovalRequest, notificationOf, summary } from './approvals.js';

const call = { project: 'semis', id: 'c12', tool: 'fs:write', path: 'index.html' };

describe('approvals in the browser', () => {
  it('sums a call up in one line: a new file, a diff, or what it runs', () => {
    expect(summary({ ...call, text: 'new file index.html\n<h1>hi</h1>\n<p>x</p>' })).toBe('index.html: new file, 2 lines');
    expect(summary({ ...call, text: 'new file index.html\n<h1>hi</h1>' })).toBe('index.html: new file, 1 line');
    const diff = ['--- index.html (now)', '+++ index.html (after)', '@@ -1,2 +1,2 @@', ' <h1>hi</h1>', '-<p>old</p>', '+<p>new</p>', '+<p>more</p>'].join('\n');
    expect(summary({ ...call, text: diff })).toBe('index.html: +2 −1');
    expect(summary({ project: 'semis', id: 'c3', tool: 'app:exec', text: 'run in the app: npm test' })).toBe('run in the app: npm test');
    expect(summary({ ...call, tool: 'fs:delete', text: 'delete index.html' })).toBe('delete index.html');
    expect(summary({ project: 'semis', id: 'c4', tool: 'x', text: 'y'.repeat(200) })).toHaveLength(120);
  });

  it('titles the notification with the project and the call', () => {
    expect(notificationOf({ ...call, text: 'new file index.html\nx' })).toEqual({ title: 'semis · c12 fs:write', message: 'index.html: new file, 1 line' });
  });

  it('keys a request by its service and call, and counts them on the badge', () => {
    expect(approvalKey({ port: 47300, project: 'semis', id: 'c12' })).toBe('47300|semis|c12');
    expect([0, 1, 12, 100].map(badgeOf)).toEqual(['', '1', '12', '99+']);
  });

  it('takes only a well-formed request', () => {
    expect(isApprovalRequest({ ...call, text: 'x' })).toBe(true);
    expect(isApprovalRequest({ project: 'semis', id: 'c1', tool: 'fs:write' })).toBe(false);
    expect(isApprovalRequest({ ...call, text: 'x', path: 3 })).toBe(false);
    expect(isApprovalRequest(null)).toBe(false);
    const scopes = [{ label: 'this file', pattern: 'index.html' }, { label: 'every file', pattern: '**' }];
    expect(isApprovalRequest({ ...call, text: 'x', scopes, preset: 0 })).toBe(true);
    expect(isApprovalRequest({ ...call, text: 'x', scopes: [{ label: 'every app:exec' }] })).toBe(true);
    expect(isApprovalRequest({ ...call, text: 'x', scopes, preset: 2 })).toBe(false);
    expect(isApprovalRequest({ ...call, text: 'x', scopes: [{ pattern: '**' }] })).toBe(false);
  });
});
