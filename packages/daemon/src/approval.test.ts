import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { readHidden } from './approval.js';

function terminal(): PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void; modes: boolean[] } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void; modes: boolean[] };
  stream.isTTY = true;
  stream.modes = [];
  stream.setRawMode = (on) => stream.modes.push(on);
  return stream;
}

describe('readHidden', () => {
  it('reads a line with backspace, in raw mode, and leaves raw mode after', async () => {
    const input = terminal();
    const value = readHidden(input);
    input.write('sk_liv');
    input.write('x\u007fe_42\r');
    expect(await value).toBe('sk_live_42');
    expect(input.modes).toEqual([true, false]);
  });

  it('gives up on Ctrl-C', async () => {
    const input = terminal();
    const value = readHidden(input);
    input.write('abc\u0003');
    expect(await value).toBeUndefined();
  });
});
