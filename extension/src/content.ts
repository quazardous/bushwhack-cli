/**
 * The content script: the driver engine running in the chat page.
 *
 * It watches for finished calls, sends the new ones to the service worker, and writes the
 * results into the composer. It never collides with the operator: results wait while
 * they are typing (and a few seconds after), and while the composer holds their text; an
 * automatic send is dropped if they touched the page after the results went in. And it
 * never runs the past: calls already in a conversation when it was bound are marked
 * handled first.
 */
import { blockText, callsInMarkdown, callsInTurn, conversationId, DRIVERS, findCalls, finishedTurns, mayHoldCalls, readComposer, selectDriver, send, writeToComposer, attachImages, type FoundCall } from '@bushwhack/chat-drivers';
import { Arrival } from './arrival.js';
import { isCallBlock, removeWithFrame } from './answer-text.js';
import { PanelOverlay } from './panel-overlay.js';
import { hookPresent } from './hook-presence.js';
import { HumanGuard, QUIET_MS } from './human-guard.js';
import { Outbox, type Delivery } from './outbox.js';
import { withoutPictures } from './pictures.js';
import type { Picture } from '@bushwhack/protocol';
import { StaleWatch } from './stale-watch.js';
import type { CallsResponse, ContentRequest, PageDump, PictureResponse, StatusResponse, TabCommand, WhoAmI } from './messages.js';
import { StatusBar, type HistoryEntry, type Tone } from './status-bar.js';

declare const __DEV__: boolean;

const driver = selectDriver(DRIVERS, location.hostname);

const CAPTURE_FLAG = 'data-bushwhack-capture';
const CAPTURE_EVENT = 'bushwhack:copied';

/**
 * A turn's markdown, as the chat's own copy button produces it. The page hook
 * (page-hook.ts) captures the clipboard write while the flag is up, so the operator's
 * clipboard is not touched. Undefined when the chat has no copy button, or it did not
 * answer in time.
 */
/** Set when a copy was skipped for want of the page hook: the page must be reloaded. */
let hookMissing = false;

function copyTurn(turn: Element, timeoutMs = 1500): Promise<string | undefined> {
  const selector = driver?.transcript.copy;
  const button = selector ? turn.querySelector(selector) : null;
  if (!(button instanceof HTMLElement)) return Promise.resolve(undefined);
  // Without the hook, the click would land in the operator's clipboard. Never.
  if (!hookPresent(document)) {
    hookMissing = true;
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const done = (text: string | undefined): void => {
      clearTimeout(timer);
      document.removeEventListener(CAPTURE_EVENT, onCopied);
      document.documentElement.removeAttribute(CAPTURE_FLAG);
      resolve(text);
    };
    const onCopied = (event: Event): void => done(String((event as CustomEvent<unknown>).detail ?? ''));
    const timer = setTimeout(() => done(undefined), timeoutMs);
    document.addEventListener(CAPTURE_EVENT, onCopied);
    document.documentElement.setAttribute(CAPTURE_FLAG, '');
    button.click();
  });
}

/** FNV-1a: a short, stable key for a call's exact text. Not security — identity. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * A turn's calls, read from its markdown through the copy button when the chat has one,
 * from its rendered code otherwise. Read once per turn, again only if the turn changed.
 */
const turnCalls = new WeakMap<Element, { size: number; calls: FoundCall[] }>();

async function callsOf(turn: Element): Promise<FoundCall[]> {
  if (!driver || !mayHoldCalls(turn)) return [];
  const size = turn.textContent?.length ?? 0;
  const cached = turnCalls.get(turn);
  if (cached?.size === size) return cached.calls;
  let calls: FoundCall[];
  if (driver.transcript.copy) {
    // A chat with a copy button is read through it, and only through it: its rendered
    // code differs (meta.ai drops lines), and a call read two ways has two identities —
    // the second reading would run it again. Not ready yet (a freshly loaded page): skip
    // the turn, the next tick tries again.
    const markdown = await copyTurn(turn);
    if (markdown === undefined) return [];
    calls = callsInMarkdown(markdown);
  } else {
    calls = callsInTurn(turn, driver);
  }
  turnCalls.set(turn, { size, calls });
  return calls;
}

/** Every finished call in the page, in page order. */
async function pageCalls(): Promise<FoundCall[]> {
  if (!driver) return [];
  const all: FoundCall[] = [];
  for (const turn of finishedTurns(document, driver)) all.push(...(await callsOf(turn)));
  return all;
}

/** The calls of the latest finished answer, the ones the model is waiting on. */
async function latestCalls(): Promise<FoundCall[]> {
  if (!driver) return [];
  const last = finishedTurns(document, driver).at(-1);
  return last ? callsOf(last) : [];
}

/**
 * Calls repeated word for word — same id, same text — in a later answer, whose results
 * were sent once already. The daemon answers them from its store; sending them again is
 * how the model gets its result back, instead of waiting on a call the page skipped as
 * handled. Once per call: a model stuck repeating itself is not answered forever.
 */
const answeredAgain = new Set<string>();
/** How many answers the page held when this one's calls were last handled. */
let answeredUpTo = -1;

function keyOf(found: FoundCall): string {
  return `${found.kind === 'call' ? found.call.id : '?'}:${fnv(found.text)}`;
}

function conversation(): string | null {
  if (!driver) return null;
  const id = conversationId(driver, location.pathname);
  return id ? `${location.hostname}/${id}` : null;
}

const handledKey = (conv: string): string => `handled:${conv}`;

async function handled(conv: string): Promise<Set<string>> {
  const got = await chrome.storage.local.get(handledKey(conv));
  return new Set((got[handledKey(conv)] as string[] | undefined) ?? []);
}

async function markHandled(conv: string, keys: string[]): Promise<void> {
  const set = await handled(conv);
  for (const key of keys) set.add(key);
  await chrome.storage.local.set({ [handledKey(conv)]: [...set] });
}

// ─── What the operator sees ──────────────────────────────────────────────────

const bar = new StatusBar(document);
const guard = new HumanGuard();
let session = '';
/** The conversation the page showed on the last pass. */
let viewing: string | null | undefined;

function show(text: string, tone: Tone = 'idle'): void {
  bar.show(session, text, tone);
}

const HISTORY = 100;
const historyKey = (conv: string): string => `history:${conv}`;

async function loadHistory(conv: string): Promise<HistoryEntry[]> {
  const got = await chrome.storage.local.get(historyKey(conv));
  return (got[historyKey(conv)] as HistoryEntry[] | undefined) ?? [];
}

async function record(conv: string, entries: HistoryEntry[]): Promise<void> {
  const all = [...(await loadHistory(conv)), ...entries].slice(-HISTORY);
  await chrome.storage.local.set({ [historyKey(conv)]: all });
  bar.setHistory(all);
}

/** The argument that says what a call is about, for the history. */
function detailOf(found: FoundCall): string | undefined {
  if (found.kind !== 'call') return found.error;
  const { args } = found.call;
  return args.path ?? (args.from && args.to ? `${args.from} → ${args.to}` : undefined) ?? args.text;
}

// ─── The loop ─────────────────────────────────────────────────────────────────

let running = false;
let loop: ReturnType<typeof setInterval> | undefined;

/**
 * The extension was reloaded or updated under this page: this copy of the script is an
 * orphan, and every chrome.* call now throws. Step aside — the worker injects a fresh
 * copy into open chat tabs when it starts.
 */
function orphaned(): boolean {
  if (chrome.runtime?.id) return false;
  if (loop !== undefined) clearInterval(loop);
  loop = undefined;
  bar.remove();
  return true;
}
/** The panel, over this page when the bushwhack icon is clicked. */
const panel = new PanelOverlay(document);
/** Whether the conversation shown was born in this page: only then may a tab binding pass to it. */
const arrival = new Arrival();
/**
 * Results not written yet — the operator is typing, the composer holds their text, or the
 * page shows another conversation — keyed by the conversation they belong to. A result is
 * only ever written into its own conversation: a call can wait minutes for approval, and
 * the operator may have moved to another chat in the meantime.
 */
const outbox = new Outbox();
/** Results written and left for the operator to send: amber until the composer is empty again. */
let awaitingSend = false;
/** Results written whose send the chat refused (busy): tried again each tick, a while. */
let retrySend: { writtenAt: number; until: number } | undefined;
const RETRY_SEND_MS = 5 * 60_000;
const RELOADED_KEY = 'bushwhack:stale-reload';
const stale = new StaleWatch({
  get: () => {
    try {
      const at = Number(sessionStorage.getItem(RELOADED_KEY));
      return at > 0 ? at : undefined;
    } catch {
      return undefined;
    }
  },
  set: (at) => {
    try {
      sessionStorage.setItem(RELOADED_KEY, String(at));
    } catch {
      // Without storage, the watch still waits between reloads within this page.
    }
  },
});

/** How long a pasted picture has to show as attached, and to stay so, before sending. */
const ATTACH_MS = 10_000;
const ATTACH_STAYS_MS = 2_000;

/**
 * Whether the chat took the pictures just pasted: more attachments than `before`, still
 * there a moment later (a refused upload may show, then go). True when the driver cannot
 * tell — the chat's own display is then all there is.
 */
async function picturesTaken(before: number): Promise<boolean> {
  const selector = driver?.composer.attachment;
  if (!selector) return true;
  const count = (): number => document.querySelectorAll(selector).length;
  const until = Date.now() + ATTACH_MS;
  while (count() <= before) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, ATTACH_STAYS_MS));
  return count() > before;
}
let autoSend = false;

async function writeWhenFree(conv: string, delivery: Delivery): Promise<void> {
  if (!driver) return;
  if (conversation() !== conv) {
    outbox.hold(conv, delivery);
    return;
  }
  if (guard.typing()) {
    outbox.hold(conv, delivery);
    show(`you are typing — results wait ${QUIET_MS / 1000}s after your last key`, 'wait');
    return;
  }
  if ((readComposer(document, driver) ?? '').trim() !== '') {
    outbox.hold(conv, delivery);
    show('results waiting — empty the message box', 'wait');
    return;
  }
  outbox.delivered(conv);
  const writtenAt = Date.now();
  writeToComposer(document, driver, delivery.text);
  // Pictures go in after the text, and take a while to upload: the send button waits for them.
  const before = driver.composer.attachment ? document.querySelectorAll(driver.composer.attachment).length : 0;
  let attached = delivery.images.length > 0 && attachImages(document, driver, delivery.images);
  if (attached && !(await picturesTaken(before))) {
    // Refused: the model must not describe a picture it does not get.
    attached = false;
    writeToComposer(document, driver, withoutPictures(delivery.text));
    report(conv, { kind: 'notice', text: 'the chat refused the picture (a quota, or its size): the model is told it is not attached' });
  }
  if (!autoSend) {
    awaitingSend = true;
    show('results in the message box — send them', 'wait');
    return;
  }
  // The send button enables once the editor has registered the paste. The operator may
  // start typing meanwhile: then the results stay in the box, for them to send.
  for (let i = 0; i < (attached ? 200 : 20); i++) {
    if (guard.touchedSince(writtenAt)) {
      awaitingSend = true;
      show('not sent: you touched the message box — send when ready', 'wait');
      return;
    }
    if (send(document, driver)) {
      show('results sent');
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  // The chat is busy — still answering, or taking the operator's own message: its button
  // stays disabled. The results stay put, and each tick tries the button again.
  awaitingSend = true;
  retrySend = { writtenAt, until: Date.now() + RETRY_SEND_MS };
  show('results in the message box — sending as soon as the chat takes them', 'wait');
}

/** Tell the terminals following this chat what it shows. Best effort: nobody may be listening. */
function report(conv: string | null, event: Extract<ContentRequest, { type: 'chat-event' }>['event']): void {
  chrome.runtime.sendMessage({ type: 'chat-event', conversation: conv, event } satisfies ContentRequest).catch(() => undefined);
}

const SCREEN_READER_ONLY = '.cdk-visually-hidden, .sr-only, .visually-hidden';

/** How many of the latest generated pictures go along with an image:save call. */
const PICTURES_SENT = 4;

/**
 * The pictures the model generated, as shown in its answers — the latest first. Read with
 * the page's own fetch: a canvas would be tainted by a CDN's picture, a blob: is the page's.
 */
async function readPictures(): Promise<Picture[]> {
  const selector = driver?.transcript.image;
  if (!selector) return [];
  // One picture may be shown twice (a thumbnail and its view): once each, by address.
  const seen = new Set<string>();
  const shown = [...document.querySelectorAll<HTMLImageElement>(`${driver!.transcript.assistantTurn} :is(${selector})`)]
    .reverse()
    .filter((i) => i.src && !seen.has(i.src) && seen.add(i.src));
  const out: Picture[] = [];
  for (const img of shown.slice(0, PICTURES_SENT)) {
    const dataUrl = (await pageRead(img.src)) ?? (await workerRead(img.src));
    // Gone from the page, or refused everywhere: the others still count, in order — and
    // the terminal says so, or image:save would pick the next one without a word.
    if (!dataUrl) report(viewing ?? null, { kind: 'notice', text: `a picture of the answer could not be read (${img.src.slice(0, 60)}…)` });
    // Its place kept, empty: a rank must name the picture the model sees, never the next one.
    out.push({ dataUrl: dataUrl ?? '', ...(img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : {}) });
  }
  return out;
}

/** A picture read with the page's own fetch: a blob: of the page, a CDN that allows it. */
async function pageRead(src: string): Promise<string | undefined> {
  try {
    const blob = await (await fetch(src)).blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

/** A picture the page may not read (no CORS), fetched by the worker from the driver's image hosts. */
async function workerRead(src: string): Promise<string | undefined> {
  if (!src.startsWith('https:')) return undefined;
  const reply = (await chrome.runtime.sendMessage({ type: 'picture', url: src } satisfies ContentRequest).catch(() => undefined)) as PictureResponse | undefined;
  return reply && 'dataUrl' in reply ? reply.dataUrl : undefined;
}

/**
 * An answer's text without its call blocks — the terminal shows the calls on their own
 * lines. Laid out off screen: innerText needs a rendered element to keep line breaks.
 */
function answerText(turn: HTMLElement): string {
  if (!driver) return '';
  const copy = turn.cloneNode(true) as HTMLElement;
  for (const block of copy.querySelectorAll(driver.transcript.blocks)) {
    if (!isCallBlock(block.textContent ?? '')) continue;
    // The chat's own frame of the block when it has one (Gemini's code-block, with its
    // "Code snippet" header), else the <pre>.
    removeWithFrame(copy, block.closest('code-block, .ur-code-block') ?? block.closest('pre') ?? block);
  }
  if (driver.transcript.chrome) for (const extra of copy.querySelectorAll(driver.transcript.chrome)) extra.remove();
  // Text for screen readers only, laid out like the rest off screen: Gemini's "Gemini said"
  // heading on every answer.
  for (const hidden of copy.querySelectorAll(SCREEN_READER_ONLY)) hidden.remove();
  const stage = document.createElement('div');
  stage.style.cssText = 'position:absolute;left:-100000px;top:0;width:800px;';
  stage.append(copy);
  document.body.append(stage);
  try {
    return (copy.innerText ?? '').trim();
  } finally {
    stage.remove();
  }
}

/**
 * The latest answer as the page shows it, reported when it changes — never the history
 * found on load, nor the one of a conversation navigated to.
 */
let answerSeen: string | undefined;
let answerOf: string | undefined;
/** The latest answer's shape and since when it has not changed: a picture has no "done" sign of its own. */
let answerShape = '';
let answerSince = 0;
/** A picture answer unchanged this long is finished, whatever the chat's own signs say. */
const PICTURE_SETTLE_MS = 8_000;
function watchAnswer(conv: string): void {
  if (!driver) return;
  if (conv !== answerOf) {
    answerOf = conv;
    answerSeen = undefined;
  }
  const turns = document.querySelectorAll<HTMLElement>(driver.transcript.assistantTurn);
  const last = turns[turns.length - 1];
  if (!last) return;
  const text = answerText(last);
  const pictures = driver.transcript.image ? new Set([...last.querySelectorAll<HTMLImageElement>(driver.transcript.image)].map((i) => i.src)).size : 0;
  let done = driver.transcript.assistantTurnDone ? last.matches(driver.transcript.assistantTurnDone) : true;
  // A picture alone may never show the chat's "done" sign (Gemini's is on the text): Gemini
  // answered a logo, and the terminal went on waiting. Unchanged a while, it is done.
  const shape = `${turns.length}\u0000${text}\u0000${pictures}`;
  if (shape !== answerShape) {
    answerShape = shape;
    answerSince = Date.now();
  }
  if (!done && pictures > 0 && Date.now() - answerSince >= PICTURE_SETTLE_MS) done = true;
  // The pictures of an answer are said too: the terminal shows no picture, and image:save wants to know.
  const said = pictures > 0 ? `(${pictures === 1 ? 'a picture' : `${pictures} pictures`} — image:save puts one in the project)` : '';
  const shown = [text, said].filter(Boolean).join('\n\n');
  const key = `${turns.length}\u0000${done}\u0000${shown}`;
  if (answerSeen === undefined) {
    answerSeen = key;
    return;
  }
  if (key === answerSeen) return;
  answerSeen = key;
  report(conv, { kind: 'answer', text: shown, done });
}

/** A prompt from the operator's terminal: written, then sent — unless the operator is typing here. */
async function promptFromTerminal(text: string): Promise<string> {
  if (!driver) return 'no-composer';
  if (guard.typing()) return 'busy';
  const current = readComposer(document, driver);
  if (current === undefined) return 'no-composer';
  if (current.trim() !== '') return 'not-empty';
  arrival.sent();
  writeToComposer(document, driver, text);
  for (let i = 0; i < 20; i++) {
    if (send(document, driver)) return 'sent';
    await new Promise((r) => setTimeout(r, 150));
  }
  return 'not-sent';
}

async function tick(): Promise<void> {
  if (!driver || running || orphaned()) return;
  running = true;
  try {
    const conv = conversation();
    const born = arrival.observe(conv, {
      composing: (readComposer(document, driver) ?? '').trim() !== '',
      answers: document.querySelectorAll(driver.transcript.assistantTurn).length,
    });
    const status = (await chrome.runtime.sendMessage({ type: 'status', conversation: conv, born } satisfies ContentRequest)) as StatusResponse | null;
    if (!status) return;
    autoSend = status.autoSend;
    if (!status.bound) {
      bar.remove();
      return;
    }
    // Nothing is added to the page until it has hydrated — its editor is the sign. Touching
    // the DOM earlier can derail the chat's own rendering.
    if (readComposer(document, driver) === undefined) return;
    if (status.elsewhere) {
      // Should this tab act again, the other will have moved on: it starts over from the history.
      viewing = undefined;
      show('this conversation is handled in another tab', 'wait');
      return;
    }
    // Everything shown belongs to one conversation: when the page moves to another (a
    // new chat getting its id, or navigating within the chat), start over from its own
    // history and forget the previous one's send state.
    if (session !== status.bound || viewing !== conv) {
      session = status.bound;
      viewing = conv;
      answeredUpTo = -1;
      answeredAgain.clear();
      awaitingSend = false;
      bar.setHistory(conv ? await loadHistory(conv) : []);
    }
    // The chat finished an answer but shows it blank: its calls cannot be read. Once, and
    // only with nothing of ours or the operator's in the message box, reload to read it.
    if (driver.transcript.stale) {
      const turns = document.querySelectorAll(driver.transcript.assistantTurn);
      const writing = driver.transcript.busy ? document.querySelector(driver.transcript.busy) !== null : false;
      const blank = !writing && turns.length > 0 && turns[turns.length - 1].matches(driver.transcript.stale);
      if (stale.observe(blank, Date.now()) && !awaitingSend && !outbox.deliverable(conv) && (readComposer(document, driver) ?? '').trim() === '') {
        report(conv, { kind: 'notice', text: `${driver.title} left its last answer blank on screen — reloading the page to read it` });
        location.reload();
        return;
      }
    }
    const waiting = outbox.deliverable(conv);
    if (waiting) {
      await writeWhenFree(waiting.conversation, waiting);
      return;
    }
    if (awaitingSend) {
      if ((readComposer(document, driver) ?? '').trim() !== '') {
        if (retrySend && autoSend && !guard.touchedSince(retrySend.writtenAt) && Date.now() < retrySend.until && send(document, driver)) {
          retrySend = undefined;
          awaitingSend = false;
          show('results sent');
          return;
        }
        if (retrySend && (guard.touchedSince(retrySend.writtenAt) || Date.now() >= retrySend.until)) {
          retrySend = undefined;
          show('results in the message box — send them', 'wait');
        }
        return;
      }
      awaitingSend = false;
      retrySend = undefined;
    }
    if (!conv) {
      show('waiting for the first message');
      return;
    }
    watchAnswer(conv);

    const done = await handled(conv);
    let fresh = (await pageCalls()).filter((found) => !done.has(keyOf(found)));
    const answers = finishedTurns(document, driver).length;
    if (answeredUpTo < 0) answeredUpTo = answers;
    if (fresh.length === 0 && answers > answeredUpTo) {
      // Nothing new in a newer answer: the model repeated a call word for word and is
      // waiting on it. Its result comes from the daemon's store.
      fresh = (await latestCalls()).filter((found) => done.has(keyOf(found)) && !answeredAgain.has(keyOf(found)));
      for (const found of fresh) answeredAgain.add(keyOf(found));
    }
    answeredUpTo = answers;
    if (hookMissing) {
      // Stays up until the page is reloaded: answers cannot be read without the hook, and
      // without it a copy click would reach the operator's clipboard.
      show('reload this page so the model\'s answers can be read', 'wait');
      return;
    }
    if (fresh.length === 0) {
      show('');
      return;
    }

    show(`running ${fresh.length} call${fresh.length > 1 ? 's' : ''}…`, 'busy');
    report(conv, {
      kind: 'calls',
      items: fresh.map((f) => (f.kind === 'call' ? { id: f.call.id, tool: f.call.tool, ...(detailOf(f) ? { detail: detailOf(f) } : {}) } : { id: f.id, tool: 'invalid call', detail: f.error })),
    });
    bar.transit('up', fresh.length);
    await record(conv, fresh.map((f) => ({
      at: Date.now(),
      dir: 'up' as const,
      id: f.kind === 'call' ? f.call.id : f.id,
      tool: f.kind === 'call' ? f.call.tool : 'invalid call',
      detail: detailOf(f),
    })));
    // image:save picks one of the pictures the model generated: they go along, read here —
    // their addresses (a blob: of the page, a CDN) mean nothing outside it.
    const pictures = fresh.some((f) => /^bushwhack:\s*image:save\s*$/m.test(f.text)) ? await readPictures() : [];
    const reply = (await chrome.runtime.sendMessage({
      type: 'calls',
      conversation: conv,
      calls: fresh.map((f) => f.text),
      ...(pictures.length ? { pictures } : {}),
    } satisfies ContentRequest)) as CallsResponse;

    if ('error' in reply) {
      show(reply.error, 'error');
      return;
    }
    await markHandled(conv, fresh.map(keyOf));
    report(conv, {
      kind: 'results',
      items: reply.summary.map((r) => ({ id: r.id, tool: r.tool, status: r.replay ? `${r.status} (replay)` : r.status, ...(r.error ? { detail: r.error } : {}) })),
    });
    bar.transit('down', reply.summary.length);
    await record(conv, reply.summary.map((r) => ({
      at: Date.now(),
      dir: 'down' as const,
      id: r.id,
      tool: r.tool,
      status: r.status,
      replay: r.replay,
    })));
    // Replays are written like anything else: calls already delivered are marked handled
    // and never sent again, so a replay here is a result that never reached the model —
    // the extension reloaded while the call was running.
    await writeWhenFree(conv, {
      text: reply.text,
      images: (reply.images ?? []).map((p, i) => ({ name: `bushwhack-${p.id ?? i}`, dataUrl: p.image })),
    });
  } catch (e) {
    // The service worker restarted mid-request: the next tick starts over, and replays
    // are answered from the daemon's store. Or the extension was reloaded: step aside.
    if (!orphaned()) show(`error: ${(e as Error).message}`, 'error');
  } finally {
    running = false;
  }
}

function devCommand(command: TabCommand): unknown {
  if (!driver) return undefined;
  switch (command.type) {
    case 'dev:dump': {
      const turns = [...document.querySelectorAll(driver.transcript.assistantTurn)].slice(-3);
      const dump: PageDump = {
        url: location.href,
        visibility: `${document.visibilityState}${document.hasFocus() ? ', focused' : ''}`,
        conversation: conversation(),
        composer: readComposer(document, driver) ?? null,
        composerCandidates: [...document.querySelectorAll('[data-testid*="composer"], [contenteditable], textarea')].map(
          (e) => `${e.tagName.toLowerCase()}${[...e.attributes].filter((a) => ['data-testid', 'contenteditable', 'role', 'placeholder', 'aria-label'].includes(a.name)).map((a) => `[${a.name}=${a.value.slice(0, 30)}]`).join('')}`,
        ),
        badge: (() => {
          const shadow = document.querySelector('[data-bushwhack-status]')?.shadowRoot;
          if (!shadow) return null;
          const tone = (shadow.querySelector('.dot') as HTMLElement | null)?.dataset.tone ?? '?';
          const rows = [...shadow.querySelectorAll('.row')].map((r) => [...r.children].map((c) => c.textContent).join(' '));
          return [`[${tone}] ${shadow.querySelector('.text')?.textContent ?? ''} ${shadow.querySelector('.io')?.textContent ?? ''}`, ...rows].join('\n');
        })(),
        turns: turns.map((turn) => ({
          done: driver.transcript.assistantTurnDone ? turn.matches(driver.transcript.assistantTurnDone) : true,
          text: ((turn as HTMLElement).innerText ?? '').slice(-6000),
        })),
        blocks: [...(turns.at(-1)?.querySelectorAll(driver.transcript.blocks) ?? [])].map((b) => blockText(b, driver)),
        blockHtml: [...(turns.at(-1)?.querySelectorAll(driver.transcript.blocks) ?? [])].map((b) => b.outerHTML.slice(0, 12000)),
        calls: findCalls(document, driver).map((f) =>
          f.kind === 'call' ? { kind: f.kind, id: f.call.id, tool: f.call.tool } : { kind: f.kind, id: f.id, tool: null, error: f.error },
        ),
      };
      return dump;
    }
    case 'dev:type':
      return writeToComposer(document, driver, command.text);
    case 'dev:send':
      return send(document, driver);
    case 'dev:probe': {
      // `<selector> @last`: the last three matches (the latest answer), not the first.
      const last = command.selector.endsWith(' @last');
      const found = [...document.querySelectorAll(last ? command.selector.slice(0, -' @last'.length) : command.selector)];
      return { count: found.length, html: (last ? found.slice(-3) : found.slice(0, 3)).map((e) => e.outerHTML.slice(0, last ? 12000 : 4000)) };
    }
    case 'dev:answer': {
      // What the terminal gets of the latest answer.
      const turns = document.querySelectorAll<HTMLElement>(driver.transcript.assistantTurn);
      const last = turns[turns.length - 1];
      return last ? { text: answerText(last) } : undefined;
    }
    case 'dev:click': {
      const target = document.querySelector<HTMLElement>(command.selector);
      target?.click();
      return Boolean(target);
    }
    case 'dev:image': {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 32;
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#2a7';
      g.fillRect(0, 0, 64, 32);
      return attachImages(document, { ...driver, composer: { ...driver.composer, images: true } }, [{ name: 'test', dataUrl: canvas.toDataURL('image/png') }]);
    }
    default:
      return undefined;
  }
}

/**
 * A second copy injected into a page that already runs one does nothing. (After an
 * extension reload the new copy lives in a fresh isolated world, so an orphan never
 * counts as "already".)
 */
const INSTANCE = '__bushwhackContent';
const already = (globalThis as Record<string, unknown>)[INSTANCE] === true;
(globalThis as Record<string, unknown>)[INSTANCE] = true;

if (driver && !already) {
  chrome.runtime.onMessage.addListener((command: TabCommand, _sender, respond) => {
    switch (command.type) {
      case 'tick':
        void tick();
        respond(true);
        return false;
      case 'panel':
        panel.toggle(`${chrome.runtime.getURL('frame.html')}?tab=${command.tabId}`);
        respond(true);
        return false;
      case 'whoami':
        respond({ host: location.hostname, driver: driver.title, conversation: conversation() } satisfies WhoAmI);
        return false;
      case 'prompt':
        void promptFromTerminal(command.text).then(respond);
        return true;
      case 'write': {
        const current = readComposer(document, driver);
        if (current === undefined) respond('no-composer');
        else if (current.trim() !== '') respond('not-empty');
        else respond(writeToComposer(document, driver, command.text) ? 'written' : 'no-composer');
        return false;
      }
      case 'dev:dump':
      case 'dev:type':
      case 'dev:send':
      case 'dev:image':
      case 'dev:probe':
      case 'dev:answer':
      case 'dev:click':
        respond(__DEV__ ? devCommand(command) : undefined);
        return false;
      case 'dev:poke': {
        const box = document.querySelector<HTMLElement>('textarea[data-testid="composer-input"]');
        if (!__DEV__ || !box) {
          respond(false);
          return false;
        }
        box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        box.focus();
        box.click();
        respond(true);
        return false;
      }
      case 'dev:copy': {
        const turns = [...document.querySelectorAll(driver.transcript.assistantTurn)];
        const turn = turns[turns.length - 1 - command.fromEnd];
        if (!__DEV__ || !turn) {
          respond(null);
          return false;
        }
        const button = driver.transcript.copy ? turn.querySelector(driver.transcript.copy) : null;
        void copyTurn(turn).then((text) =>
          respond({
            text: text ?? null,
            button: button ? (button.getAttribute('aria-label') ?? button.outerHTML.slice(0, 80)) : null,
          }),
        );
        return true;
      }
      case 'baseline': {
        const conv = conversation();
        if (!conv) {
          respond(true);
          return false;
        }
        void pageCalls().then((calls) => markHandled(conv, calls.map(keyOf))).then(() => respond(true));
        return true;
      }
    }
  });

  // Chat UIs stream and re-render constantly; a steady tick is simpler and cheaper than
  // reacting to every mutation, and one second is well under a model's pace. A hidden
  // tab's timers are slowed to about one a minute: the worker then sends ticks too.
  guard.watch(document);
  loop = setInterval(() => void tick(), 1000);
}
