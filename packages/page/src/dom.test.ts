// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { clickPage, fillPage, queryPage, snapshotPage, storagePage, waitPage } from './dom.js';

beforeEach(() => {
  document.title = 'Shop';
  document.body.innerHTML = `
    <h1>Welcome</h1>
    <p>Two items in the cart.</p>
    <a href="/cart" id="cart">Cart</a>
    <form><label for="q">Search</label><input id="q" name="q" value="shoes">
    <input type="password" name="pw" value="hunter2"></form>
    <button class="buy">Buy now</button>
    <div style="display:none"><p>hidden text</p></div>`;
});

describe('snapshotPage', () => {
  it('outlines what a person sees, with selectors, and never a password', () => {
    const out = snapshotPage(10_000);
    expect(out.ok && out.data).toContain('# Welcome');
    expect(out.ok && out.data).toContain('Two items in the cart.');
    expect(out.ok && out.data).toContain('[link] "Cart" → /cart  (#cart)');
    expect(out.ok && out.data).toContain('[input:text] "Search" = "shoes"  (#q)');
    expect(out.ok && out.data).toContain('[button] "Buy now"');
    expect(out.ok && out.data).not.toContain('hunter2');
    expect(out.ok && out.data).not.toContain('hidden text');
  });

  it('keeps text in inline markup, once — a bold name was lost', () => {
    document.body.innerHTML = `
      <ul><li><div><b>Tomate Noire de Crimée</b> <span class="meta">— x12</span><br><span>2026-04-20</span></div><button>Delete</button></li></ul>
      <p>Hello <em>big</em> world</p>`;
    const out = snapshotPage(10_000);
    const lines = out.ok ? out.data.split('\n') : [];
    expect(lines).toContain('Tomate Noire de Crimée — x12 2026-04-20');
    expect(lines).toContain('Hello big world');
    // Not again, piece by piece.
    expect(lines).not.toContain('— x12');
    expect(lines).not.toContain('big');
    expect(lines).toContain('[button] "Delete"  (ul > li > button)');
  });

  it('stays within its bound', () => {
    const out = snapshotPage(40);
    expect(out.ok && out.data.length).toBeLessThan(80);
    expect(out.ok && out.data).toContain('cut at 40');
  });
});

describe('storagePage', () => {
  it('lists the page\'s keys, gives a value, and says when a key is not there', async () => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('semis', JSON.stringify([{ variety: 'Tomate', quantity: 12 }]));
    sessionStorage.setItem('tab', 'list');
    const listed = await storagePage('', '', '', 20_000);
    expect(listed.ok && listed.data).toContain('localStorage:\n  semis  (36 characters)');
    expect(listed.ok && listed.data).toContain('sessionStorage:\n  tab  (4 characters)');
    const value = await storagePage('semis', '', '', 20_000);
    expect(value.ok && value.data).toBe('localStorage "semis" (36 characters):\n[{"variety":"Tomate","quantity":12}]');
    expect(await storagePage('nope', '', '', 20_000)).toMatchObject({ ok: false, error: expect.stringMatching(/no key "nope"/) });
    expect((await storagePage('semis', '', '', 10)).ok && (await storagePage('semis', '', '', 10) as { data: string }).data).toContain('cut at 10');
  });
});

describe('actions', () => {
  it('queries, clicks and fills', () => {
    const q = queryPage('input', 5);
    expect(q.ok && q.data.count).toBe(2);
    let clicked = 0;
    document.querySelector('.buy')!.addEventListener('click', () => clicked++);
    expect(clickPage('.buy').ok).toBe(true);
    expect(clicked).toBe(1);
    const events: string[] = [];
    document.querySelector('#q')!.addEventListener('input', () => events.push('input'));
    expect(fillPage('#q', 'boots').ok).toBe(true);
    expect((document.querySelector('#q') as HTMLInputElement).value).toBe('boots');
    expect(events).toEqual(['input']);
  });

  it('reports a bad selector or a missing element instead of throwing', () => {
    expect(queryPage('[[', 1)).toEqual({ ok: false, error: '"[[" is not a valid selector' });
    expect(clickPage('.nope')).toEqual({ ok: false, error: 'nothing matches ".nope"' });
    expect(fillPage('.buy', 'x')).toEqual({ ok: false, error: '".buy" is not a field' });
  });

  it('waits for an element, and gives up in time', async () => {
    setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p class="late">late</p>'), 150);
    expect((await waitPage('.late', 2000)).ok).toBe(true);
    expect(await waitPage('.never', 250)).toMatchObject({ ok: false });
  });
});
