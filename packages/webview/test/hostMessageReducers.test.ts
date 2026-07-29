import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScopeFilter, parseViewFilter, parseSortOrder, parseGroupBy,
  dropKey, appendOutput, computeRunAggregate
} from '../src/hooks/appState/hostMessageReducers.js';

test('parseScopeFilter validates against the allowed set', () => {
  assert.equal(parseScopeFilter('project'), 'project');
  assert.equal(parseScopeFilter('global'), 'global');
  assert.equal(parseScopeFilter('all'), 'all');
  assert.equal(parseScopeFilter(undefined), 'all');
  assert.equal(parseScopeFilter('garbage'), 'all');
});

test('parseViewFilter keeps built-in, migrates the old string, drops junk', () => {
  assert.deepEqual(parseViewFilter(['built-in']), ['built-in']);
  assert.deepEqual(parseViewFilter(['built-in', 'x']), ['built-in']);
  assert.deepEqual(parseViewFilter('built-in'), ['built-in']); // migrate old persisted string
  assert.deepEqual(parseViewFilter(undefined), []);
});

test('parseSortOrder passes known orders, else falls back to activity', () => {
  for (const v of ['desc', 'asc', 'newest', 'oldest']) assert.equal(parseSortOrder(v), v);
  assert.equal(parseSortOrder(undefined), 'activity');
  assert.equal(parseSortOrder('weird'), 'activity');
});

test('parseGroupBy is tag only for the literal tag', () => {
  assert.equal(parseGroupBy('tag'), 'tag');
  assert.equal(parseGroupBy('list'), 'list');
  assert.equal(parseGroupBy(undefined), 'list');
});

test('dropKey returns a new map without the key and never mutates the input', () => {
  const map = { a: 1, b: 2 };
  const out = dropKey(map, 'a');
  assert.deepEqual(out, { b: 2 });
  assert.deepEqual(map, { a: 1, b: 2 }); // input untouched
  assert.deepEqual(dropKey(map, 'missing'), { a: 1, b: 2 }); // absent key is a no-op copy
});

test('appendOutput appends or replaces based on the flag', () => {
  assert.equal(appendOutput('foo', 'bar', true), 'foobar');
  assert.equal(appendOutput('foo', 'bar', false), 'bar');
  assert.equal(appendOutput(undefined, undefined, true), '');
  assert.equal(appendOutput(undefined, 'x', false), 'x');
});

test('computeRunAggregate rolls up steps, cost, tokens and durations', () => {
  const changed: any = {
    steps: {
      s1: { completionStatus: 'done', executionStatus: 'completed', reviewStatus: 'approved',
            costUsd: 0.5, tokensUsed: 100,
            startedAt: '2026-07-29T00:00:00.000Z', completedAt: '2026-07-29T00:00:02.000Z',
            reviewCompletedAt: '2026-07-29T00:00:03.000Z' },
      s2: { completionStatus: 'not_ready', executionStatus: 'running', reviewStatus: 'pending',
            costUsd: 0.25, tokensUsed: 40 },
      s3: { completionStatus: 'not_ready', executionStatus: 'failed', reviewStatus: 'pending' }
    }
  };
  const agg = computeRunAggregate(changed);
  assert.equal(agg.completedSteps, 1);
  assert.equal(agg.inProgressSteps, 1);   // s2 running
  assert.equal(agg.failedSteps, 1);       // s3 failed
  assert.equal(agg.totalSteps, 3);
  assert.equal(agg.reviewing, false);
  assert.equal(agg.costUsd, 0.75);
  assert.equal(agg.tokensUsed, 140);
  assert.equal(agg.taskTimeMs, 2000);     // s1 started→completed
  assert.equal(agg.reviewTimeMs, 1000);   // s1 completed→reviewCompleted
});

test('computeRunAggregate flags reviewing when a step waits for review', () => {
  const changed: any = { steps: { s: { completionStatus: 'not_ready', executionStatus: 'completed', reviewStatus: 'waiting_human' } } };
  const agg = computeRunAggregate(changed);
  assert.equal(agg.reviewing, true);
  assert.equal(agg.inProgressSteps, 1);   // reviewing counts as in-progress
});
