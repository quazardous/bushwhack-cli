import { describe, it, expect } from 'vitest';
import { dotenvValues, parseDotenv, removeDotenv, scrambleDotenv, setDotenv } from './dotenv.js';

const FILE = [
  '# Stripe',
  'STRIPE_KEY=sk_test_123',
  '',
  'export DATABASE_URL="postgres://u:p w@db/app"',
  "QUOTED='a \"b\" c'",
  'EMPTY=',
  'INLINE=value # comment',
  '',
].join('\n');

describe('dotenv', () => {
  it('parses values the common way', () => {
    expect([...dotenvValues(FILE)]).toEqual([
      ['STRIPE_KEY', 'sk_test_123'],
      ['DATABASE_URL', 'postgres://u:p w@db/app'],
      ['QUOTED', 'a "b" c'],
      ['INLINE', 'value'],
    ]);
  });

  it('scrambles every value, keeps names, comments, order and blanks, and shows empty as empty', () => {
    expect(scrambleDotenv(FILE)).toBe(
      [
        '# Stripe',
        'STRIPE_KEY=‹secret:STRIPE_KEY›',
        '',
        'export DATABASE_URL=‹secret:DATABASE_URL›',
        'QUOTED=‹secret:QUOTED›',
        'EMPTY=',
        'INLINE=‹secret:INLINE›',
        '',
      ].join('\n'),
    );
    expect(scrambleDotenv(FILE)).not.toMatch(/sk_test|postgres|value/);
  });

  it('replaces a value in place and leaves every other line byte for byte', () => {
    const out = setDotenv(FILE, 'STRIPE_KEY', 'sk_live_9 9');
    expect(out).toBe(FILE.replace('STRIPE_KEY=sk_test_123', 'STRIPE_KEY="sk_live_9 9"'));
    expect(dotenvValues(out).get('STRIPE_KEY')).toBe('sk_live_9 9');
  });

  it('appends a new variable with its comment, quoting what needs it, and reads it back', () => {
    const out = setDotenv(FILE, 'NEW_ONE', 'a"b\\c\nd', 'the new one');
    expect(out.endsWith('# the new one\nNEW_ONE="a\\"b\\\\c\\nd"\n')).toBe(true);
    expect(dotenvValues(out).get('NEW_ONE')).toBe('a"b\\c\nd');
  });

  it('removes a variable and nothing else', () => {
    const { text, removed } = removeDotenv(FILE, 'EMPTY');
    expect(removed).toBe(true);
    expect(text).toBe(FILE.replace('EMPTY=\n', ''));
    expect(removeDotenv(FILE, 'NOPE').removed).toBe(false);
  });

  it('refuses a variable name that is not one', () => {
    expect(() => setDotenv(FILE, 'BAD NAME', 'x')).toThrow(/not a variable name/);
  });

  it('keeps a commented-out assignment a comment', () => {
    expect(parseDotenv('# OLD=1\n')[0].kind).toBe('other');
  });
});
