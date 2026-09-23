// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { isCallBlock, removeWithFrame } from './answer-text.js';

describe('an answer\'s text, calls taken out', () => {
  it('takes a call block out with the frame the chat draws around it, and keeps the prose', () => {
    // meta.ai, as observed: a header with the language, then the block, in a wrapper.
    const turn = document.createElement('div');
    turn.innerHTML =
      '<div><div dir="auto"><p>Je liste le projet :</p></div></div>' +
      '<div><div><div><div><span>bushwhack</span></div><div></div></div><div><pre><code>---\nbushwhack: fs:list\nid: c1\n---end</code></pre></div></div></div>' +
      '<div><div dir="auto"><p>Puis je lis le README.</p></div></div>';
    removeWithFrame(turn, turn.querySelector('pre')!);
    expect(turn.textContent).toBe('Je liste le projet :Puis je lis le README.');
  });

  it('stops at the first ancestor that holds anything else', () => {
    const turn = document.createElement('div');
    turn.innerHTML = '<div><p>Voilà :</p><pre><code>---\nbushwhack: fs:list\nid: c1\n---end</code></pre></div>';
    removeWithFrame(turn, turn.querySelector('pre')!);
    expect(turn.textContent).toBe('Voilà :');
  });

  it('knows a call block before it is written: empty, or its first line only', () => {
    expect(isCallBlock('')).toBe(true);
    expect(isCallBlock('---\n')).toBe(true);
    expect(isCallBlock('---\nbushwhack: fs:read\nid: c1\n---end')).toBe(true);
    expect(isCallBlock('npm install')).toBe(false);
    expect(isCallBlock('---\ntitle: a markdown front matter\n---')).toBe(false);
  });
});
