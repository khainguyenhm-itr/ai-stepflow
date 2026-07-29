import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runKey, isRunKeyOf } from '../../src/runOrchestratorHelpers.js';

test('runKey namespaces a step under its run so two runs never collide', () => {
  assert.equal(runKey('runA', 'implement'), 'runA::implement');
  assert.notEqual(runKey('runA', 'implement'), runKey('runB', 'implement'));
});

test('isRunKeyOf matches only keys of the given run', () => {
  assert.equal(isRunKeyOf('runA::implement', 'runA'), true);
  assert.equal(isRunKeyOf('runB::implement', 'runA'), false);
  // a runId that is a textual prefix of another must not false-match
  assert.equal(isRunKeyOf('runA10::x', 'runA1'), false);
});

test('isRunKeyOf and runKey agree — a built key belongs to its run', () => {
  const key = runKey('2026-07-29T00:00:00.000Z', 'step-1');
  assert.equal(isRunKeyOf(key, '2026-07-29T00:00:00.000Z'), true);
  assert.equal(isRunKeyOf(key, '2026-07-29T00:00:00.001Z'), false);
});
