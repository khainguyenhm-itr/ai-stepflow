import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReadySteps, parseVerdict, summarizeUsage, missingMarkers } from '@ai-stepflow/core';

test('computeReadySteps unlocks a dependent once all its deps are done', () => {
  const steps = [
    { id: 'a' },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['a', 'b'] }
  ];
  assert.deepEqual(computeReadySteps(steps, new Set(['a']), new Set(['a'])), ['b']);
  assert.deepEqual(computeReadySteps(steps, new Set(['a', 'b']), new Set(['a', 'b'])), ['c']);
});

test('computeReadySteps never auto-starts root steps or already started/done steps', () => {
  const steps = [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }];
  assert.deepEqual(computeReadySteps(steps, new Set(), new Set()), []);
  assert.deepEqual(computeReadySteps(steps, new Set(['a']), new Set(['a', 'b'])), []);
});

test('computeReadySteps waits until every dependency is done', () => {
  const steps = [{ id: 'a' }, { id: 'b' }, { id: 'c', dependsOn: ['a', 'b'] }];
  assert.deepEqual(computeReadySteps(steps, new Set(['a']), new Set(['a'])), []);
});

test('parseVerdict reads pass/reject and aliases, embedded in prose', () => {
  assert.deepEqual(parseVerdict('Looks good. {"decision":"pass","reason":"all checks ok"}'), { decision: 'pass', reason: 'all checks ok' });
  assert.deepEqual(parseVerdict('{"decision":"approved"}'), { decision: 'pass', reason: undefined });
  assert.deepEqual(parseVerdict('{"decision":"rejected","reason":"missing tests"}'), { decision: 'reject', reason: 'missing tests' });
});

test('parseVerdict returns undefined for unparseable or absent verdicts', () => {
  assert.equal(parseVerdict(''), undefined);
  assert.equal(parseVerdict('no json here'), undefined);
  assert.equal(parseVerdict('{"decision":"maybe"}'), undefined);
});

test('summarizeUsage sums every token bucket and handles absence', () => {
  assert.equal(summarizeUsage({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 }), 20);
  assert.equal(summarizeUsage({ input_tokens: 4 }), 4);
  assert.equal(summarizeUsage(undefined), undefined);
  assert.equal(summarizeUsage(null), undefined);
});

test('missingMarkers reports only the markers absent from the content', () => {
  assert.deepEqual(missingMarkers('## Summary\n## Plan', ['## Summary', '## Plan']), []);
  assert.deepEqual(missingMarkers('## Summary', ['## Summary', '## Test Plan']), ['## Test Plan']);
});
