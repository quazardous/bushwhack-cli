// @vitest-environment jsdom
/**
 * The popup's list refreshes every two seconds. What must hold: a code being pasted stays
 * where it is, and the status changes without anything else moving.
 */
import { describe, it, expect } from 'vitest';
import type { DiscoveredSession } from './messages.js';
import { reconcile, shortPath, type ListContext } from './popup-list.js';

const ctx = (connected: Record<string, boolean> = {}): ListContext => ({
  links: { dev: null, sessions: connected },
  pair: () => {},
  bind: () => {},
  forget: () => {},
  focus: () => {},
  open: (url) => opened.push(url),
});
const opened: string[] = [];

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
