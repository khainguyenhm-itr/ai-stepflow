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

test('deep=false approves when the validator passes (no LLM)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-review-'));
  let llmCalled = false;
  try {
    writeFileSync(path.join(dir, 'pass.mjs'), "export default () => ({ decision: 'pass', reason: 'ok' });", 'utf8');
    const result = await reviewStepArtifacts({
      workspaceRoot: dir, step: step({ validatorPath: 'pass.mjs' }), runState, deep: false,
      reviewKit: 'kit', artifacts: { text: 'x', count: 1 },
      runner: async () => { llmCalled = true; return { success: true, exitCode: 0, resultText: '' }; }
    });
    assert.equal(result.status, 'approved');
    assert.equal(result.source, 'validator-only');
    assert.equal(llmCalled, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validator-only review rejects when the explicit validator is missing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-review-'));
  try {
    const result = await reviewStepArtifacts({
      workspaceRoot: dir, step: step({ validatorPath: 'non-existent.mjs' }), runState, deep: false,
      reviewKit: 'kit', artifacts: { text: 'x', count: 1 },
      runner: stubRunner('')
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.source, 'validator');
    assert.match(result.note, /Validator: reject — Failed to load validator/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('deep review waits for a human when the review kit or artifacts are missing', async () => {
  const missingKit = await reviewStepArtifacts({
    workspaceRoot: '/tmp', step: step(), runState, deep: true,
    reviewKit: '', artifacts: { text: 'content', count: 1 },
    runner: stubRunner('{"decision":"pass"}')
  });
  assert.equal(missingKit.status, 'waiting_human');
  assert.equal(missingKit.source, 'review-setup');
  assert.match(missingKit.note, /review kit not installed/);

  const missingArtifacts = await reviewStepArtifacts({
    workspaceRoot: '/tmp', step: step(), runState, deep: true,
    reviewKit: 'kit', artifacts: { text: '', count: 0 },
    runner: stubRunner('{"decision":"pass"}')
  });
  assert.equal(missingArtifacts.status, 'waiting_human');
  assert.equal(missingArtifacts.source, 'review-setup');
  assert.match(missingArtifacts.note, /no produced artifacts/);
});

test('readProducedArtifacts enforces per-file and total caps', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-artifacts-'));
  try {
    const big = 'x'.repeat(REVIEW_ARTIFACT_CHAR_CAP + 5000);
    writeFileSync(path.join(dir, 'a.txt'), big, 'utf8');
    const { text, count } = readProducedArtifacts(step({}, { produces: ['./a.txt'] }), dir, {});
    assert.equal(count, 1);
    assert.match(text, /…\[(?:middle )?truncated\]/);
    assert.ok(text.length <= REVIEW_TOTAL_CHAR_CAP + 200, 'payload stays within the total cap (plus headers)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readProducedArtifacts prefers review.filePath even when produces is empty', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-review-artifact-'));
  try {
    const filePath = path.join(dir, 'docs', 'EPIC-1', 'review.md');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'review me', 'utf8');
    const { text, count } = readProducedArtifacts(step({ filePath: 'docs/{ticket}/review.md' }), dir, { ticket: 'EPIC-1' });
    assert.equal(count, 1);
    assert.match(text, /review me/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readProducedArtifacts de-duplicates review.filePath and produces', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-review-artifact-'));
  try {
    writeFileSync(path.join(dir, 'review.md'), 'same file', 'utf8');
    const { count } = readProducedArtifacts(step({ filePath: './review.md' }, { produces: ['./review.md'] }), dir, {});
    assert.equal(count, 1);
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
