import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReadySteps, seedStartedSteps, extractJsonObject, parseVerdict, summarizeUsage, missingMarkers } from '@ai-stepflow/core';

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

test('seedStartedSteps treats a review-rejected step as started so auto-advance never re-runs it', () => {
  const started = seedStartedSteps({
    a: { executionStatus: 'completed', reviewStatus: 'approved', completionStatus: 'done' } as any,
    b: { executionStatus: 'ready', reviewStatus: 'rejected', completionStatus: 'not_ready' } as any,
    c: { executionStatus: 'ready', reviewStatus: 'pending', completionStatus: 'not_ready' } as any
  });
  // a (done) and b (rejected) count as started; only the pristine c stays a candidate.
  assert.equal(started.has('a'), true);
  assert.equal(started.has('b'), true);
  assert.equal(started.has('c'), false);
  // With b marked started, a parallel sibling finishing can't re-launch it.
  const steps = [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'd', dependsOn: ['a'] }];
  assert.deepEqual(computeReadySteps(steps, new Set(['a']), started), ['d']);
});

test('parseVerdict reads pass/reject and aliases, embedded in prose', () => {
  assert.deepEqual(parseVerdict('Looks good. {"decision":"pass","reason":"all checks ok"}'), { decision: 'pass', reason: 'all checks ok' });
  assert.deepEqual(parseVerdict('{"decision":"approved"}'), { decision: 'pass', reason: undefined });
  assert.deepEqual(parseVerdict('{"decision":"rejected","reason":"missing tests"}'), { decision: 'reject', reason: 'missing tests' });
});

test('parseVerdict recovers a decision from malformed output', () => {
  // A decision field survives even without valid JSON braces/quotes.
  assert.deepEqual(parseVerdict("decision: reject — missing tests"), { decision: 'reject' });
  assert.deepEqual(parseVerdict('The change should be rejected due to a regression.'), { decision: 'reject' });
});

test('parseVerdict leans pass when the reply carries no rejection signal', () => {
  // Auto-review must not stall on formatting: a non-empty reply always resolves to pass|reject.
  assert.deepEqual(parseVerdict('no json here'), { decision: 'pass' });
  assert.deepEqual(parseVerdict('{"decision":"maybe"}'), { decision: 'pass' });
  assert.deepEqual(parseVerdict('Looks good to me.'), { decision: 'pass' });
});

test('parseVerdict returns undefined only for an empty reply (routes to a human)', () => {
  assert.equal(parseVerdict(''), undefined);
  assert.equal(parseVerdict('   \n  '), undefined);
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

test('extractJsonObject preserves Markdown code fences inside JSON strings', () => {
  const response = {
    reply: 'Generated.',
    name: 'test-coverage-audit',
    description: 'Audits test coverage.',
    instructions: '# Audit\n```bash\nnpx gitnexus status\n```\nUse {symbolName} when querying.'
  };
  const output = `\`\`\`json\n${JSON.stringify(response)}\n\`\`\``;

  assert.deepEqual(JSON.parse(extractJsonObject(output)), response);
});

test('extractJsonObject handles prose, nested objects, and escaped quotes', () => {
  const response = { reply: 'Done "now".', flow: { name: 'test', inputs: {} } };
  const output = `Here is the result:\n${JSON.stringify(response)}\nGenerated successfully.`;

  assert.deepEqual(JSON.parse(extractJsonObject(output)), response);
});

test('extractJsonObject rejects output without a complete valid JSON object', () => {
  assert.throws(() => extractJsonObject('No JSON here.'), /no JSON object found/);
  assert.throws(() => extractJsonObject('{"reply":"truncated"'), /no JSON object found/);
});
