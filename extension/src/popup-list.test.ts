// @vitest-environment jsdom
/**
 * The popup's list refreshes every two seconds. What must hold: a code being pasted stays
 * where it is, and the status changes without anything else moving.
 */
import { describe, it, expect } from 'vitest';
import type { DiscoveredSession } from './messages.js';
import { reconcile, renderDetail, shortPath, terminalSummary, type ListContext } from './popup-list.js';

const ctx = (connected: Record<string, boolean> = {}): ListContext => ({
  links: { dev: null, sessions: connected },
  pair: () => {},
  bind: () => {},
  forget: () => {},
  focus: () => {},
  open: (url) => opened.push(url),
  details: (s) => detailed.push(s.nodeId),
  closeTerminal: (s, terminal) => closed.push(`${s.nodeId} ${terminal}`),
});
const opened: string[] = [];
const detailed: string[] = [];
const closed: string[] = [];

const session = (nodeId: string, paired: boolean, service?: string): DiscoveredSession => ({
  port: 47300,
  session: nodeId,
  folder: `/p/${nodeId}`,
  nodeId,
  ...(service ? { service } : {}),
  paired,
  chats: [],
});

describe('the popup list', () => {
  it('keeps a code field — and what is being typed in it — across refreshes', () => {
    const list = document.createElement('div');
    document.body.append(list);
    reconcile(list, [session('shop', false, 'svc')], ctx());
    const input = list.querySelector('input')!;
    input.value = 'MAM7-HM';
    input.focus();
    for (let i = 0; i < 3; i++) reconcile(list, [session('shop', false, 'svc')], ctx());
    expect(list.querySelector('input')).toBe(input);
    expect(input.value).toBe('MAM7-HM');
    expect(document.activeElement).toBe(input);
  });

  it('updates a status in place, and rebuilds a card only when what it shows changed', () => {
    const list = document.createElement('div');
    reconcile(list, [session('shop', true)], ctx());
    const card = list.querySelector('.session')!;
    expect(card.querySelector('.status')!.textContent).toBe(' · idle');
    reconcile(list, [session('shop', true)], ctx({ shop: true }));
    expect(list.querySelector('.session')).toBe(card);
    expect(card.querySelector('.status')!.textContent).toBe(' · connected');
    expect(card.querySelector('.dot')!.className).toBe('dot on');
    reconcile(list, [{ ...session('shop', true), chats: [{ conversation: 'gemini/abc' }] }], ctx({ shop: true }));
    expect(list.querySelector('.session')).not.toBe(card);
  });

  it('shows the end of a long folder path, the whole of it on hover', () => {
    expect(shortPath('/home/op/work/shop')).toBe('…/work/shop');
    expect(shortPath('/srv/shop')).toBe('/srv/shop');
    const list = document.createElement('div');
    reconcile(list, [{ ...session('shop', true), folder: '/home/op/work/shop' }], ctx());
    const folder = list.querySelector<HTMLElement>('.folder')!;
    expect([folder.textContent, folder.title]).toEqual(['…/work/shop', '/home/op/work/shop']);
  });

  it('offers to open the project\'s app when it has one', () => {
    const list = document.createElement('div');
    reconcile(list, [{ ...session('shop', true, 'svc'), url: 'http://shop.localhost' }, session('blog', true, 'svc')], ctx());
    const links = list.querySelectorAll<HTMLAnchorElement>('.app a');
    expect([...links].map((a) => a.textContent)).toEqual(['http://shop.localhost']);
    links[0].click();
    expect(opened).toEqual(['http://shop.localhost']);
  });

  it('pairs a service, not a project: one header per service, with the code field, then its projects', () => {
    const list = document.createElement('div');
    reconcile(list, [session('shop', false, 'svc'), session('solo', false), session('blog', false, 'svc')], ctx());
    expect(list.querySelectorAll('input')).toHaveLength(2);
    expect(list.querySelectorAll('.session input')).toHaveLength(0);
    // svc's header, its two projects, then the lone session's header and card.
    expect([...list.children].map((c) => (c as HTMLElement).dataset.node ?? `[${(c as HTMLElement).dataset.group}]`)).toEqual(['[svc]', 'shop', 'blog', '[solo]', 'solo']);
    reconcile(list, [session('shop', true, 'svc'), session('blog', true, 'svc')], ctx());
    expect(list.querySelectorAll('input')).toHaveLength(0);
    expect(list.querySelector('.service')!.textContent).toContain('this browser is paired');
  });
});

describe('forgetting a pairing', () => {
  const forgotten: string[] = [];
  const forgetting = (): ListContext => ({ ...ctx(), forget: (s) => forgotten.push(s.nodeId) });

  it('is the service\'s, not a project\'s: one Forget, in the header', () => {
    const list = document.createElement('div');
    reconcile(list, [session('shop', true, 'svc'), session('blog', true, 'svc')], forgetting());
    expect([...list.querySelectorAll('.session button')].filter((b) => b.textContent?.startsWith('Forget'))).toHaveLength(0);
    expect([...list.querySelectorAll('.service button')].map((b) => b.textContent)).toEqual(['Forget…']);
  });

  it('asks first, says what goes with it, and forgets only on a yes', () => {
    forgotten.length = 0;
    const list = document.createElement('div');
    document.body.append(list);
    reconcile(list, [session('shop', true, 'svc'), session('blog', true, 'svc')], forgetting());
    const header = list.querySelector<HTMLElement>('.service')!;
    header.querySelector<HTMLButtonElement>('button')!.click();
    const box = header.querySelector('.confirm')!;
    expect(box.textContent).toContain('its 2 projects leave this list');
    expect(forgotten).toEqual([]);
    // Still asked across a refresh, and asked once however often it is clicked.
    reconcile(list, [session('shop', true, 'svc'), session('blog', true, 'svc')], forgetting());
    header.querySelector<HTMLButtonElement>('button')!.click();
    expect(header.querySelectorAll('.confirm')).toHaveLength(1);
    [...box.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click();
    expect(header.querySelector('.confirm')).toBeNull();
    expect(forgotten).toEqual([]);
    header.querySelector<HTMLButtonElement>('button')!.click();
    [...header.querySelectorAll<HTMLButtonElement>('.confirm button')].find((b) => b.textContent === 'Forget')!.click();
    expect(forgotten).toEqual(['shop']);
    list.remove();
  });
});

describe('the pairing code field', () => {
  it('stands out, takes the keyboard when nothing has it, and pairs on Enter', async () => {
    const paired: string[] = [];
    const list = document.createElement('div');
    document.body.append(list);
    (document.activeElement as HTMLElement | null)?.blur();
    reconcile(list, [session('shop', false, 'svc')], { ...ctx(), pair: (_, code) => paired.push(code) });
    await Promise.resolve();
    const input = list.querySelector<HTMLInputElement>('input.pair-code')!;
    expect(document.activeElement).toBe(input);
    input.value = 'ABCD-EFGH';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(paired).toEqual(['ABCD-EFGH']);
    list.remove();
  });

  it('sums up the terminals on the card, and opens the project\'s details', () => {
    const list = document.createElement('div');
    const shop = { ...session('shop', true, 'svc'), terminals: [{ id: 'approvals:a', approves: true, label: 'pid 12 · pts/3', since: 0 }, { id: 'chat:b', approves: false, since: 0 }], approvals: 'here' as const };
    reconcile(list, [shop], ctx());
    expect(list.querySelector('.terminals')!.textContent).toBe('>_ 2 terminals · approvals asked there');
    expect(list.querySelector('.terminals .term')!.classList.contains('approving')).toBe(true);
    (([...list.querySelectorAll('button')].find((b) => b.textContent === 'Details'))!).click();
    expect(detailed).toEqual(['shop']);
    expect(terminalSummary({ terminals: [] })).toBeUndefined();
  });

  it('closes a terminal from the details on a second click of its power button', () => {
    const shop = { ...session('shop', true, 'svc'), terminals: [{ id: 'approvals:a', approves: true, label: 'pid 12 · pts/3', since: 0 }], approvals: 'here' as const };
    const detail = renderDetail(shop, ctx(), () => {});
    document.body.append(detail);
    expect(detail.querySelector('.terminal .what span')!.textContent).toBe('pid 12 · pts/3');
    expect(detail.querySelector('.terminal .what small')!.textContent).toBe('takes the approvals');
    expect(detail.querySelector('.aside-head h1')!.textContent).toBe('shop');
    const power = detail.querySelector('button.power') as HTMLButtonElement;
    power.click();
    expect(closed).toEqual([]);
    expect(power.classList.contains('armed')).toBe(true);
    expect(detail.querySelector('.arm-note')!.textContent).toBe('click again to close it — its approvals then go to the browser');
    power.click();
    expect(closed).toEqual(['shop approvals:a']);
    expect(power.classList.contains('armed')).toBe(false);
  });

});
