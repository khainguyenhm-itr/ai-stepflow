import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlow, formatFlowError, isFlowShape, isFlowRunStateShape } from '@ai-stepflow/core';

test('parseFlow fills defaults for a minimal hand-written flow', () => {
  const flow = parseFlow({ id: 'f1', steps: [{ id: 's1', agent: 'po', skills: ['prd'] }] }, 'fallback', '/x/f1.yaml');
  assert.equal(flow.id, 'f1');
  assert.equal(flow.name, 'f1');
  assert.equal(flow.sourcePath, '/x/f1.yaml');
  const step = flow.steps[0];
  assert.equal(step.review.required, false);
  assert.equal(step.completion.requireMarkDone, false);
  assert.deepEqual(step.skills, ['prd']);
});

test('parseFlow uses the fallback id when none is given', () => {
  const flow = parseFlow({ steps: [] }, 'derived-from-filename', '/x/derived-from-filename.yaml');
  assert.equal(flow.id, 'derived-from-filename');
  assert.equal(flow.name, 'derived-from-filename');
});

test('parseFlow accepts snake_case produces_contains as an alias', () => {
  const flow = parseFlow(
    { id: 'f', steps: [{ id: 's', produces: ['out.md'], produces_contains: ['## Summary'] }] },
    'f',
    '/x/f.yaml'
  );
  assert.deepEqual(flow.steps[0].produces, ['out.md']);
  assert.deepEqual(flow.steps[0].producesContains, ['## Summary']);
});

test('parseFlow preserves requires and placeholder-based artifact paths', () => {
  const flow = parseFlow(
    { id: 'f', steps: [{ id: 's', requires: ['docs/{ticket}/brief.md'], produces: ['docs/{ticket}/plan.md'] }] },
    'f',
    '/x/f.yaml'
  );
  assert.deepEqual(flow.steps[0].requires, ['docs/{ticket}/brief.md']);
  assert.deepEqual(flow.steps[0].produces, ['docs/{ticket}/plan.md']);
});

test('parseFlow preserves validator config', () => {
  const flow = parseFlow(
    {
      id: 'f',
      steps: [{ id: 's', review: { required: true, type: 'ai', validatorPath: 'scripts/validate.mjs', validatorTimeoutMs: 5000 } }]
    },
    'f',
    '/x/f.yaml'
  );
  assert.equal(flow.steps[0].review.validatorPath, 'scripts/validate.mjs');
  assert.equal(flow.steps[0].review.validatorTimeoutMs, 5000);
});

test('parseFlow degrades an unknown review type to undefined instead of failing', () => {
  const flow = parseFlow({ id: 'f', steps: [{ id: 's', review: { required: true, type: 'robot' } }] }, 'f', '/x/f.yaml');
  assert.equal(flow.steps[0].review.required, true);
  assert.equal(flow.steps[0].review.type, undefined);
});

test('isFlowShape accepts a well-formed flow and rejects malformed payloads', () => {
  assert.equal(isFlowShape({ id: 'f', sourcePath: '/f.yaml', steps: [{ id: 's' }] }), true);
  assert.equal(isFlowShape({ id: 'f', sourcePath: '/f.yaml', steps: [] }), true);
  // missing sourcePath / non-object step / steps not an array → rejected
  assert.equal(isFlowShape({ id: 'f', steps: [{ id: 's' }] }), false);
  assert.equal(isFlowShape({ id: 'f', sourcePath: '/f.yaml', steps: ['oops'] }), false);
  assert.equal(isFlowShape({ id: 'f', sourcePath: '/f.yaml', steps: [{ title: 'no id' }] }), false);
  assert.equal(isFlowShape(null), false);
  assert.equal(isFlowShape('nope'), false);
});

test('isFlowShape preserves extra keys (passthrough, no normalization)', () => {
  // The guard only validates; it must not reject a flow carrying fields it does not model.
  assert.equal(isFlowShape({ id: 'f', sourcePath: '/f.yaml', name: 'My Flow', inputs: {}, steps: [{ id: 's', custom: 1 }] }), true);
});

test('isFlowRunStateShape accepts a real run state and rejects malformed ones', () => {
  const good = { flowId: 'f', runId: 'r1', steps: { s: { executionStatus: 'ready', reviewStatus: 'not_required', completionStatus: 'not_ready' } } };
  assert.equal(isFlowRunStateShape(good), true);
  // step missing a required status field
  assert.equal(isFlowRunStateShape({ flowId: 'f', runId: 'r1', steps: { s: { executionStatus: 'ready' } } }), false);
  // steps must be a map of objects, not an array
  assert.equal(isFlowRunStateShape({ flowId: 'f', runId: 'r1', steps: [] }), false);
  assert.equal(isFlowRunStateShape({ runId: 'r1', steps: {} }), false);
  assert.equal(isFlowRunStateShape(undefined), false);
});

test('parseFlow throws a readable error when steps is not a list', () => {
  assert.throws(
    () => parseFlow({ id: 'f', steps: 'not-an-array' }, 'f', '/x/f.yaml'),
    (e: unknown) => {
      const msg = formatFlowError(e);
      assert.match(msg, /steps/);
      return true;
    }
  );
});
