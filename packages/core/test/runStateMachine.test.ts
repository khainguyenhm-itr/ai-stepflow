import { test } from 'node:test';
import assert from 'node:assert/strict';
import { 
  Flow,
  initRunState, applyDependencyLocks, markRunning, markCompleted, markFailed, markCancelled,
  applyAiReview, applyHumanReview, markDone, doneStepIds
} from '@ai-stepflow/core';

function step(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: id, agent: 'a', skill: 's', review: { required: false }, completion: { requireMarkDone: false }, ...extra } as any;
}

const flow: Flow = {
  id: 'f', name: 'f', description: '', inputs: {}, sourcePath: '/f.yaml',
  steps: [step('a'), step('b', { dependsOn: ['a'], review: { required: true, type: 'human' } })]
};

test('initRunState locks a dependent and leaves the root ready', () => {
  const st = initRunState(flow, { runId: 'r1' });
  assert.equal(st.steps.a.executionStatus, 'ready');
  assert.equal(st.steps.b.executionStatus, 'locked');
});

test('markRunning transitions status', () => {
  let st = initRunState(flow, { runId: 'r1' });
  st = markRunning(st, flow, 'a');
  assert.equal(st.steps.a.executionStatus, 'running');
});

test('markCompleted transitions status and applies metrics', () => {
  let st = initRunState(flow, { runId: 'r1' });
  st = markRunning(st, flow, 'a');
  st = markCompleted(st, flow, 'a', { costUsd: 0.1 });
  assert.equal(st.steps.a.executionStatus, 'completed');
  assert.equal(st.steps.a.costUsd, 0.1);
  // Root step with no review is 'done' immediately
  assert.equal(st.steps.a.completionStatus, 'done');
  // 'b' should now be unlocked
  assert.equal(st.steps.b.executionStatus, 'ready');
});

test('markFailed transitions status', () => {
  let st = initRunState(flow, { runId: 'r1' });
  st = markFailed(st, flow, 'a', { output: 'error' });
  assert.equal(st.steps.a.executionStatus, 'failed');
  assert.equal(st.steps.a.output, 'error');
});

test('markCancelled marks the attempt cancelled and stays re-runnable', () => {
  let st = initRunState(flow, { runId: 'r1' });
  st = markRunning(st, flow, 'a');
  st = markCancelled(st, flow, 'a', { output: 'partial output' });
  assert.equal(st.steps.a.executionStatus, 'cancelled');
  assert.equal(st.steps.a.output, 'partial output');
  assert.equal(st.steps.a.completionStatus, 'not_ready');
  const entry = (st.steps.a.history ?? []).find(h => h.status === 'cancelled');
  assert.ok(entry, 'expected a cancelled history entry');
  // A cancelled step can be re-run.
  st = markRunning(st, flow, 'a');
  assert.equal(st.steps.a.executionStatus, 'running');
});

test('applyHumanReview transitions status', () => {
  let st = initRunState(flow, { runId: 'r1' });
  st = markRunning(st, flow, 'a');
  st = markCompleted(st, flow, 'a');
  st = markRunning(st, flow, 'b');
  st = markCompleted(st, flow, 'b');
  assert.equal(st.steps.b.reviewStatus, 'pending');
  
  st = applyHumanReview(st, flow, 'b', { decision: 'approved' });
  assert.equal(st.steps.b.reviewStatus, 'approved');
  assert.equal(st.steps.b.completionStatus, 'ready_to_mark_done');
});

test('markDone transitions status to done', () => {
  let st = initRunState(flow, { runId: 'r1' });
  st = markRunning(st, flow, 'a');
  st = markCompleted(st, flow, 'a');
  st = markRunning(st, flow, 'b');
  st = markCompleted(st, flow, 'b');
  st = applyHumanReview(st, flow, 'b', { decision: 'approved' });
  st = markDone(st, flow, 'b');
  assert.equal(st.steps.b.completionStatus, 'done');
});

test('transitions append a timestamped history trail', () => {
  let st = initRunState(flow, { runId: 'r1' });
  assert.equal(st.steps.a.history, undefined);
  st = markRunning(st, flow, 'a');
  st = markCompleted(st, flow, 'a');
  const hist = st.steps.a.history ?? [];
  assert.deepEqual(hist.map(h => h.status), ['running', 'completed']);
  assert.ok(hist.every(h => typeof h.timestamp === 'string' && h.timestamp.length > 0));
});

test('markRunning tracks revision and records reruns in history', () => {
  let st = initRunState(flow, { runId: 'r1' });
  st = markRunning(st, flow, 'a');
  assert.equal(st.steps.a.revision, 1);
  st = markCompleted(st, flow, 'a');
  st = markRunning(st, flow, 'a');
  assert.equal(st.steps.a.revision, 2);
  const rerun = (st.steps.a.history ?? []).find(h => h.message === 'rerun #2');
  assert.ok(rerun, 'expected a rerun history entry');
});

test('human review records the decision and comment in history', () => {
  let st = initRunState(flow, { runId: 'r1' });
  st = markRunning(st, flow, 'a');
  st = markCompleted(st, flow, 'a');
  st = markRunning(st, flow, 'b');
  st = markCompleted(st, flow, 'b');
  st = applyHumanReview(st, flow, 'b', { decision: 'rejected', comment: 'needs tests' });
  const entry = (st.steps.b.history ?? []).find(h => h.status === 'human-review rejected');
  assert.ok(entry);
  assert.equal(entry?.message, 'needs tests');
});

test('doneStepIds returns the set of completed steps', () => {
  let st = initRunState(flow, { runId: 'r1' });
  st = markRunning(st, flow, 'a');
  st = markCompleted(st, flow, 'a');
  const done = doneStepIds(st);
  assert.ok(done.has('a'));
  assert.ok(!done.has('b'));
});
