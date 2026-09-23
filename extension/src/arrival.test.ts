import { describe, it, expect } from 'vitest';
import { Arrival } from './arrival.js';

const idle = { composing: false, answers: 0 };

describe('how a page came to its conversation', () => {
  it('a new chat whose first message was typed here is born here, and stays so', () => {
    const a = new Arrival();
    expect(a.observe(null, idle)).toBe(false);
    a.observe(null, { composing: true, answers: 0 });
    expect(a.observe('meta.ai/c1', idle)).toBe(true);
    expect(a.observe('meta.ai/c1', { composing: false, answers: 1 })).toBe(true);
  });

  it('a new chat sent from the terminal, or answered before its id showed, is born here', () => {
    const fromTerminal = new Arrival();
    fromTerminal.observe(null, idle);
    fromTerminal.sent();
    expect(fromTerminal.observe('meta.ai/c1', idle)).toBe(true);
    const answered = new Arrival();
    answered.observe(null, idle);
    answered.observe(null, { composing: false, answers: 1 });
    expect(answered.observe('meta.ai/c1', { composing: false, answers: 5 })).toBe(true);
  });

  it('an old conversation reached from a new chat is not born here', () => {
    // Nothing on its way: the sidebar was clicked.
    const clicked = new Arrival();
    clicked.observe(null, idle);
    expect(clicked.observe('meta.ai/old', { composing: false, answers: 4 })).toBe(false);
    // Something typed, but the conversation shown is longer than one exchange.
    const typed = new Arrival();
    typed.observe(null, { composing: true, answers: 0 });
    expect(typed.observe('meta.ai/old', { composing: false, answers: 3 })).toBe(false);
  });

  it('a page loaded on a conversation, or moving between two, has none born here', () => {
    const loaded = new Arrival();
    expect(loaded.observe('meta.ai/c1', { composing: true, answers: 0 })).toBe(false);
    const born = new Arrival();
    born.observe(null, { composing: true, answers: 0 });
    born.observe('meta.ai/c1', idle);
    expect(born.observe('meta.ai/c2', idle)).toBe(false);
    // Back to the one born here: by navigation now — its binding moved long ago.
    expect(born.observe('meta.ai/c1', idle)).toBe(false);
  });
});
