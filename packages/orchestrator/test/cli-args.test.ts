import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Mirrors the flag parser in cli.ts. Kept in step by these tests. */
function flag(args: string[], name: string, fallback: string): string {
  const start = args.indexOf(`--${name}`);
  if (start < 0) return fallback;
  const words: string[] = [];
  for (let i = start + 1; i < args.length && !args[i]!.startsWith('--'); i++) {
    words.push(args[i]!);
  }
  return words.length ? words.join(' ') : fallback;
}

test('rejoins a goal that npm split on spaces', () => {
  const args = ['--goal', 'Build', 'a', 'URL', 'shortener.'];
  assert.equal(flag(args, 'goal', 'fallback'), 'Build a URL shortener.');
});

test('stops at the next flag', () => {
  const args = ['--goal', 'Build', 'a', 'thing', '--rehearse', '--keep-alive'];
  assert.equal(flag(args, 'goal', 'fallback'), 'Build a thing');
});

test('falls back when the flag is absent or has no value', () => {
  assert.equal(flag(['--rehearse'], 'goal', 'fallback'), 'fallback');
  assert.equal(flag(['--goal', '--rehearse'], 'goal', 'fallback'), 'fallback');
});
