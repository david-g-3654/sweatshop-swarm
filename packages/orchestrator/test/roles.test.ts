import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, verdictOf, suiteOf, shippedUrl } from '../src/roles.js';

const PLAN_BLOCK = `Here is my plan.

\`\`\`json
{"summary":"a url shortener","workstreams":[{"owner":"engineer-a","title":"core","brief":"x"},{"owner":"engineer-b","title":"http","brief":"y"}],"acceptance":["it shortens"]}
\`\`\``;

test('parses the planner json block', () => {
  const plan = parsePlan(PLAN_BLOCK);
  assert.equal(plan?.workstreams.length, 2);
  assert.equal(plan?.workstreams[0]?.owner, 'engineer-a');
});

test('takes the last json block when the model shows its working', () => {
  const draft = '```json\n{"summary":"draft","workstreams":[]}\n```\n' + PLAN_BLOCK;
  assert.equal(parsePlan(draft)?.summary, 'a url shortener');
});

test('returns null rather than a half-parsed plan', () => {
  assert.equal(parsePlan('no json here'), null);
  assert.equal(parsePlan('```json\n{broken\n```'), null);
});

test('reads verdicts only on their own line', () => {
  assert.equal(verdictOf('1. bad thing\n\nVERDICT: CHANGES_REQUESTED'), 'changes');
  assert.equal(verdictOf('VERDICT: APPROVED'), 'approved');
  // A mention inside prose must not be mistaken for the verdict itself.
  assert.equal(verdictOf('I would normally say VERDICT: APPROVED but'), null);
});

test('reads suite and deploy markers', () => {
  assert.equal(suiteOf('all good\nSUITE: GREEN'), 'green');
  assert.equal(suiteOf('SUITE: RED'), 'red');
  assert.equal(shippedUrl('done\nSHIPPED: https://example.trycloudflare.com'), 'https://example.trycloudflare.com');
  assert.equal(shippedUrl('FAILED: port in use'), null);
});

test('verdict markers survive the decoration models add to them', () => {
  // Asking for a bare line reliably gets bold some of the time.
  assert.equal(verdictOf('findings...\n\n**VERDICT: CHANGES_REQUESTED**'), 'changes');
  assert.equal(verdictOf('`VERDICT: APPROVED`'), 'approved');
  assert.equal(verdictOf('- VERDICT: APPROVED'), 'approved');
  assert.equal(verdictOf('3. VERDICT: CHANGES_REQUESTED'), 'changes');
  assert.equal(suiteOf('**SUITE: RED**'), 'red');
  assert.equal(shippedUrl('**SHIPPED: https://a.trycloudflare.com**'), 'https://a.trycloudflare.com');
});

test('decoration tolerance does not loosen the line anchor', () => {
  // The whole point of anchoring: musing about a verdict is not a verdict.
  assert.equal(verdictOf('I would normally say VERDICT: APPROVED but not here'), null);
  assert.equal(verdictOf('see the **VERDICT: APPROVED** convention in the docs for detail'), null);
});
