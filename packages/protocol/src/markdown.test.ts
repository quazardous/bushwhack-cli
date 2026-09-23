import { describe, it, expect } from 'vitest';
import { extractFencedBlocks } from './markdown.js';

describe('extractFencedBlocks', () => {
  it('returns each fenced block, lines intact — conflict markers included', () => {
    const md = 'Text.\n\n```bushwhack\n---\nbushwhack: fs:edit\nid: c6\n---\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n---end\n```\n\nMore.';
    expect(extractFencedBlocks(md)).toEqual(['---\nbushwhack: fs:edit\nid: c6\n---\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n---end']);
  });

  it('keeps an inner fence inside a longer one', () => {
    expect(extractFencedBlocks('````\n```js\nx\n```\n````')).toEqual(['```js\nx\n```']);
  });

  it('does not close on a fence of the other character, or a shorter one', () => {
    expect(extractFencedBlocks('~~~\n```\n~~\n~~~')).toEqual(['```\n~~']);
  });

  it('removes the opening fence\'s indentation from the lines', () => {
    expect(extractFencedBlocks('  ```\n  a\n    b\n  ```')).toEqual(['a\n  b']);
  });

  it('keeps blank lines as they are', () => {
    expect(extractFencedBlocks('```\na\n\n\nb\n```')).toEqual(['a\n\n\nb']);
  });

  it('runs an unclosed fence to the end', () => {
    expect(extractFencedBlocks('```\na\nb')).toEqual(['a\nb']);
  });
});
