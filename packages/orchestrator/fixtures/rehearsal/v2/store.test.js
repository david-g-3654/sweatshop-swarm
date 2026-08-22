import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise, submit, ranked, total, uniqueWords, weighted, snapshot, reset } from './store.js';

test('counts a word and returns the normalised form', () => {
  reset();
  assert.equal(submit('Agents'), 'agents');
  assert.equal(total(), 1);
});

test('normalising folds case, spacing and punctuation into one word', () => {
  reset();
  submit('Agents');
  submit('  AGENTS ');
  submit('agents!');
  assert.equal(uniqueWords(), 1, 'these are all the same word');
  assert.equal(ranked()[0].count, 3);
});

test('rejects input that is not a usable word', () => {
  reset();
  assert.throws(() => submit(''), /not be empty/);
  assert.throws(() => submit('   '), /not be empty/);
  assert.throws(() => submit(null), /must be a string/);
  assert.throws(() => submit(42), /must be a string/);
  assert.throws(() => submit('x'.repeat(50)), /at most/);
  assert.throws(() => submit('!!!'), /letters or digits/);
});

test('markup cannot survive normalisation', () => {
  reset();
  // The renderer never builds HTML from these, but defence in depth: whatever
  // comes out of here must not be able to carry a tag.
  for (const attack of ['<b>hi</b>', '<script>x</script>', '"><img src=x>']) {
    let out = null;
    try {
      out = submit(attack);
    } catch {
      continue; // rejected outright is also fine
    }
    assert.doesNotMatch(out, /[<>"'`=/]/, `"${attack}" produced "${out}"`);
  }
});

test('keeps letters, digits, hyphens and apostrophes', () => {
  assert.equal(normalise("Don't"), "don't");
  assert.equal(normalise('well-known'), 'well-known');
  assert.equal(normalise('claude5'), 'claude5');
});

test('ranks most-said first, breaking ties alphabetically', () => {
  reset();
  submit('swarm');
  submit('swarm');
  submit('zebra');
  submit('agents');
  const list = ranked();
  assert.equal(list[0].word, 'swarm');
  assert.equal(list[1].word, 'agents', 'equal counts sort alphabetically');
  assert.equal(list[2].word, 'zebra');
});

test('weights scale against the most-said word', () => {
  reset();
  for (let i = 0; i < 10; i++) submit('loud');
  submit('quiet');
  const [first, second] = weighted();
  assert.equal(first.weight, 1);
  assert.ok(second.weight < 0.2 && second.weight > 0);
});

test('a burst of submissions loses none of them', () => {
  reset();
  for (let i = 0; i < 500; i++) submit('spam');
  assert.equal(total(), 500);
  assert.equal(ranked()[0].count, 500);
});

test('the cloud is bounded and says so rather than growing for ever', () => {
  reset();
  for (let i = 0; i < 300; i++) submit(`word${i}`);
  assert.equal(uniqueWords(), 300);
  assert.throws(() => submit('onetoomany'), /full/);
  // An existing word is still countable once the cloud is full.
  assert.equal(submit('word0'), 'word0');
});

test('snapshot is what the page renders', () => {
  reset();
  submit('agents');
  const snap = snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.unique, 1);
  assert.deepEqual(Object.keys(snap.words[0]).sort(), ['count', 'weight', 'word']);
});
