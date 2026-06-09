import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reviewStepArtifacts, readProducedArtifacts, loadReviewKit, REVIEW_ARTIFACT_CHAR_CAP, REVIEW_TOTAL_CHAR_CAP } from '@ai-stepflow/core';
import { FlowRunState, FlowStep } from '@ai-stepflow/core';

function step(reviewPatch: Partial<FlowStep['review']> = {}, extra: Partial<FlowStep> = {}): FlowStep {
  return { id: 's', title: 'Step', agent: 'a', skill: 'k', review: { required: true, type: 'ai', ...reviewPatch }, completion: { requireMarkDone: false }, ...extra } as FlowStep;
}
const runState: FlowRunState = { flowId: 'f', runId: 'r', source: '/f.yaml', projectPath: '/tmp', inputs: {}, steps: {} };

/** A StepRunner stub that returns a canned result text. */
const stubRunner = (resultText: string) => async () => ({ success: true, exitCode: 0, resultText });

test('validator reject short-circuits before the LLM', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-review-'));
  try {
    writeFileSync(path.join(dir, 'reject.mjs'), "export default () => ({ decision: 'reject', reason: 'bad' });", 'utf8');
    let llmCalled = false;
    const result = await reviewStepArtifacts({
      workspaceRoot: dir, step: step({ validatorPath: 'reject.mjs' }), runState, deep: true,
      reviewKit: 'kit', artifacts: { text: 'x', count: 1 },
      runner: async () => { llmCalled = true; return { success: true, exitCode: 0, resultText: '{"decision":"pass"}' }; }
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.source, 'validator');
    assert.equal(llmCalled, false, 'LLM must not run after a validator reject');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deep=false approves on the validator alone (no LLM)', async () => {
  let llmCalled = false;
  const result = await reviewStepArtifacts({
    workspaceRoot: '/tmp', step: step(), runState, deep: false,
    reviewKit: 'kit', artifacts: { text: 'x', count: 1 },
    runner: async () => { llmCalled = true; return { success: true, exitCode: 0, resultText: '' }; }
  });
  assert.equal(result.status, 'approved');
  assert.equal(result.source, 'validator-only');
  assert.equal(llmCalled, false);
});

test('deep LLM review parses a pass verdict', async () => {
  const result = await reviewStepArtifacts({
    workspaceRoot: '/tmp', step: step(), runState, deep: true,
    reviewKit: 'kit', artifacts: { text: 'content', count: 1 },
    runner: stubRunner('{"decision":"pass","reason":"looks good"}')
  });
  assert.equal(result.status, 'approved');
  assert.equal(result.source, 'llm');
  assert.equal(result.note, 'looks good');
});

test('deep LLM review with an unparseable verdict waits for a human', async () => {
  const result = await reviewStepArtifacts({
    workspaceRoot: '/tmp', step: step(), runState, deep: true,
    reviewKit: 'kit', artifacts: { text: 'content', count: 1 },
    runner: stubRunner('I think it is probably fine?')
  });
  assert.equal(result.status, 'waiting_human');
});

test('readProducedArtifacts enforces per-file and total caps', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-artifacts-'));
  try {
    const big = 'x'.repeat(REVIEW_ARTIFACT_CHAR_CAP + 5000);
    writeFileSync(path.join(dir, 'a.txt'), big, 'utf8');
    const { text, count } = readProducedArtifacts(step({}, { produces: ['a.txt'] }), dir, {});
    assert.equal(count, 1);
    assert.match(text, /…\[truncated\]/);
    assert.ok(text.length <= REVIEW_TOTAL_CHAR_CAP + 200, 'payload stays within the total cap (plus headers)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadReviewKit prefers a project copy, returns empty when absent', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-kit-'));
  try {
    assert.equal(loadReviewKit(dir, 'nope-missing.md'), '');
    mkdirSync(path.join(dir, '.claude', 'reviews'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'reviews', 'kit.md'), 'PROJECT KIT', 'utf8');
    assert.equal(loadReviewKit(dir, 'kit.md'), 'PROJECT KIT');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
