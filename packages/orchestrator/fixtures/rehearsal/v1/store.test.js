import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submit, ranked, total, uniqueWords } from './store.js';

test('counts a word', () => {
  submit('agents');
  assert.equal(total(), 1);
});

test('folds case and spacing', () => {
  submit('Swarm');
  submit(' swarm ');
  assert.equal(ranked().find((e) => e.word === 'swarm').count, 2);
});

test('reports how many unique words there are', () => {
  assert.ok(uniqueWords() >= 2);
});
