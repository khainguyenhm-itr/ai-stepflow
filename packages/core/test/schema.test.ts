import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlow, formatFlowError } from '@ai-stepflow/core';

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
