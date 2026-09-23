// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';

type Log = { console: { level: string; text: string }[] };

describe('the app page\'s native dialogs', () => {
  beforeAll(async () => {
    await import('./page-recorder.js');
  });

  it('answer at once instead of freezing the page, and show in page:console', () => {
    window.alert('Erreur lors de l\'enregistrement');
    expect(window.confirm('Supprimer ?')).toBe(true);
    expect(window.prompt('Nom ?', 'Tomate')).toBe('Tomate');
    expect(window.prompt('Nom ?')).toBeNull();
    const log = (window as unknown as { __bushwhackPage: Log }).__bushwhackPage;
    expect(log.console.filter((l) => l.level === 'dialog').map((l) => l.text)).toEqual([
      "alert: Erreur lors de l'enregistrement",
      'confirm: Supprimer ? → OK (answered by bushwhack)',
      'prompt: Nom ? → "Tomate" (answered by bushwhack)',
      'prompt: Nom ? → cancelled (answered by bushwhack)',
    ]);
  });
});

describe('what the page fails to load itself', () => {
  beforeAll(async () => {
    await import('./page-recorder.js');
  });

  it('shows in page:console: a script, a stylesheet or an image that did not load — not a script error twice', () => {
    const log = (window as unknown as { __bushwhackPage: Log }).__bushwhackPage;
    const before = log.console.length;
    const script = document.createElement('script');
    script.src = 'https://cdn.example/lib.js';
    document.body.append(script);
    script.dispatchEvent(new Event('error'));
    const sheet = document.createElement('link');
    sheet.href = 'http://demo.localhost/missing.css';
    document.body.append(sheet);
    sheet.dispatchEvent(new Event('error'));
    expect(log.console.slice(before).map((l) => [l.level, l.text])).toEqual([
      ['error', 'failed to load <script> https://cdn.example/lib.js'],
      ['error', 'failed to load <link> http://demo.localhost/missing.css'],
    ]);
  });
});
