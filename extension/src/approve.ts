/**
 * The approval page: one call waiting for a yes, in full — the whole diff — with Yes and No,
 * and what to remember the answer for (this file, its kind of file, every file…). Opened by a click on the call's notification, in a window of its own; see
 * approvals.ts for why here and not in the panel.
 */
import type { ApprovalPageRequest, ApprovalItem } from './messages.js';
import type { PendingApproval } from './approvals.js';

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const key = new URLSearchParams(location.search).get('key') ?? '';

function ask<T>(request: ApprovalPageRequest): Promise<T> {
  return chrome.runtime.sendMessage(request) as Promise<T>;
}

let finished = false;

/** The request is no longer waiting: say why, and close. */
function over(text: string): void {
  if (finished) return;
  finished = true;
  $('text').replaceChildren();
  $('actions').replaceChildren();
  $('text').append(Object.assign(document.createElement('div'), { className: 'done', textContent: text }));
  setTimeout(() => window.close(), 1500);
}

/** The diff's lines, coloured: added, removed, and the hunks' headers. */
function render(text: string): void {
  const box = $('text');
  box.replaceChildren();
  for (const line of text.split('\n')) {
    const span = document.createElement('span');
    span.textContent = `${line}\n`;
    if (line.startsWith('@@')) span.className = 'hunk';
    else if (line.startsWith('+') && !line.startsWith('+++')) span.className = 'add';
    else if (line.startsWith('-') && !line.startsWith('---')) span.className = 'del';
    box.append(span);
  }
}

async function main(): Promise<void> {
  const request = await ask<PendingApproval | null>({ type: 'approval', key });
  if (!request) return over('Already answered — or it waited too long.');
  document.title = `bushwhack — ${request.id} ${request.tool}?`;
  $('title').textContent = `${request.project} · ${request.id} ${request.tool}`;
  $('path').textContent = request.path ?? '';
  render(request.text);
  // What to remember the answer for: offered by the service, "this file" ticked for a change.
  const scopes = request.scopes ?? [];
  const box = $('remember') as HTMLInputElement;
  const select = $('scope') as HTMLSelectElement;
  if (scopes.length > 0) {
    $('remember-row').hidden = false;
    select.replaceChildren(...scopes.map((s, i) => Object.assign(document.createElement('option'), { value: String(i), textContent: s.pattern ? `${s.label} — ${s.pattern}` : s.label })));
    box.checked = request.preset !== undefined;
    select.value = String(request.preset ?? 0);
    select.onchange = () => (box.checked = true);
    const note = (): void => {
      $('note').textContent = box.checked
        ? 'Remembered in the project\'s .bushwhack/approval-rules.json: the next matching calls get the same answer without asking — each still shown in the terminal.'
        : 'Nothing is written before you answer.';
    };
    box.onchange = note;
    select.addEventListener('change', note);
    note();
  }
  let answering = false;
  const answer = (verdict: 'yes' | 'no'): void => {
    answering = true;
    for (const b of ['yes', 'no']) ($(b) as HTMLButtonElement).disabled = true;
    const scope = box.checked ? scopes[Number(select.value)] : undefined;
    const remember = scope ? (scope.pattern ?? true) : undefined;
    void ask<{ answered?: boolean }>({ type: 'approval-answer', key, verdict, ...(remember !== undefined ? { remember } : {}) }).then((r) =>
      over(r?.answered ? `${verdict === 'no' ? 'Refused' : 'Accepted'}${scope ? `, and remembered for ${scope.pattern ?? scope.label}` : ''}.` : 'Already answered — or it waited too long.'),
    );
  };
  $('yes').onclick = () => answer('yes');
  $('no').onclick = () => answer('no');
  // Answered elsewhere (the notification, a terminal) or given up by the service: the
  // worker's state no longer lists it.
  chrome.runtime.onMessage.addListener((message: { type?: string; approvals?: ApprovalItem[] }) => {
    if (!answering && message?.type === 'popup-state' && message.approvals && !message.approvals.some((a) => a.key === key)) over('Answered elsewhere — or it waited too long.');
  });
}

main().catch((e: unknown) => over(`Could not load it: ${(e as Error).message}`));
