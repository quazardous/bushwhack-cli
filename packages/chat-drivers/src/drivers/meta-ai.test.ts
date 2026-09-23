// @vitest-environment jsdom
/**
 * meta.ai's answer in miniature, shaped like the live one (2026-09-23): what sits in the
 * answer but is not the model's words — the follow-ups meta.ai offers under it — is left
 * out of the answer's text, and the model's own words stay.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { selectDriver } from '../spec.js';
import { DRIVERS } from '../index.js';

const META = selectDriver(DRIVERS, 'www.meta.ai')!;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the meta.ai driver', () => {
  it('leaves meta.ai\'s follow-up suggestions out of the answer, not the answer nor its action bar', () => {
    document.body.innerHTML = `<div data-testid="assistant-message" data-streaming-complete="true">
      <div><div><div>
        <div><p>Here is the square version.</p></div>
        <div><div><div class="divide-y">
          <button><svg></svg><span>Save this square version as logo.webp</span></button>
          <button><svg></svg><span>Make a 32x32 favicon of this icon</span></button>
        </div></div></div>
      </div>
      <div><div data-slot="flexbox"><div><div><button aria-label="Copy"><svg></svg></button></div></div></div></div>
      </div></div>
    </div>`;
    const turn = document.querySelector(META.transcript.assistantTurn)!;
    const left = [...turn.querySelectorAll(META.transcript.chrome!)].map((e) => e.textContent?.trim());
    expect(left).toEqual(['Save this square version as logo.webp', 'Make a 32x32 favicon of this icon']);
    const copy = turn.cloneNode(true) as HTMLElement;
    for (const extra of copy.querySelectorAll(META.transcript.chrome!)) extra.remove();
    expect(copy.textContent).toContain('Here is the square version.');
    expect(copy.querySelector('[aria-label="Copy"]')).not.toBeNull();
  });

  it('leaves a code block\'s header out of the answer, not its code', () => {
    document.body.innerHTML = `<div data-testid="assistant-message" data-streaming-complete="true">
      <p>Here it is:</p>
      <div class="ur-code-block">
        <div class="ur-code-block__header"><div class="ur-code-block__header-left"><span class="ur-code-block__metadata">Code</span></div><button><svg></svg></button></div>
        <pre><code>npm test</code></pre>
      </div>
    </div>`;
    const copy = document.querySelector(META.transcript.assistantTurn)!.cloneNode(true) as HTMLElement;
    for (const extra of copy.querySelectorAll(META.transcript.chrome!)) extra.remove();
    expect(copy.textContent).not.toContain('Code');
    expect(copy.textContent).toContain('npm test');
    expect(copy.textContent).toContain('Here it is:');
  });
});
