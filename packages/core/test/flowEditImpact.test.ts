import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessFlowEdit, stepProgressed } from '../src/flowEditImpact.js';
import { initRunState } from '../src/runStateMachine.js';
import type { Flow, FlowStep, FlowRunState } from '../src/types.js';

function step(id: string, dependsOn?: string[]): FlowStep {
  return { id, title: id, agent: 'po', skill: 'prd', dependsOn, review: { required: true, type: 'human' } } as FlowStep;
}

function flowOf(steps: FlowStep[], over: Partial<Flow> = {}): Flow {
  return {
    id: 'f1', name: 'Flow One', description: '', inputs: {}, steps,
    sourcePath: '/repo/.claudesteps/flows/f1.yaml', ...over,
  } as Flow;
}

/** A run of `flow` where the listed steps carry the given execution state. */
function runOf(flow: Flow, over: Record<string, Partial<FlowRunState['steps'][string]>> = {}): FlowRunState {
  const state = initRunState(flow, { runId: 'run-1', projectPath: '/repo', inputs: {} });
  for (const [id, patch] of Object.entries(over)) {
    state.steps[id] = { ...state.steps[id], ...patch };
  }
  return state;
}

test('stepProgressed is true for any step that consumed real work', () => {
  assert.equal(stepProgressed(undefined), false);
  assert.equal(stepProgressed({ executionStatus: 'ready', reviewStatus: 'pending', completionStatus: 'not_ready', output: '' }), false);
  assert.equal(stepProgressed({ executionStatus: 'locked', reviewStatus: 'pending', completionStatus: 'not_ready', output: '' }), false);
  for (const executionStatus of ['running', 'completed', 'failed', 'cancelled', 'skipped'] as const) {
    assert.equal(stepProgressed({ executionStatus, reviewStatus: 'pending', completionStatus: 'not_ready', output: '' }), true, executionStatus);
  }
  assert.equal(stepProgressed({ executionStatus: 'ready', reviewStatus: 'approved', completionStatus: 'done', output: '' }), true);
});

test('appending a step after the running one is safe', () => {
  const oldFlow = flowOf([step('a'), step('b', ['a'])]);
  const newFlow = flowOf([step('a'), step('b', ['a']), step('c', ['b'])]);
  const run = runOf(oldFlow, { a: { completionStatus: 'done' }, b: { executionStatus: 'running' } });

  const impact = assessFlowEdit(oldFlow, newFlow, run);

  assert.equal(impact.safe, true);
  assert.deepEqual(impact.addedStepIds, ['c']);
  assert.deepEqual(impact.changes, [{ stepId: 'c', kind: 'added', blocking: false }]);
});

test('inserting a step upstream of the running step is blocking', () => {
  const oldFlow = flowOf([step('a'), step('b', ['a'])]);
  const newFlow = flowOf([step('a'), step('x', ['a']), step('b', ['x'])]);
  const run = runOf(oldFlow, { a: { completionStatus: 'done' }, b: { executionStatus: 'running' } });

  const impact = assessFlowEdit(oldFlow, newFlow, run);

  assert.equal(impact.safe, false);
  const blocking = impact.changes.filter(c => c.blocking).map(c => c.stepId).sort();
  assert.deepEqual(blocking, ['b', 'x']);
});

test('modifying a completed step is blocking', () => {
  const oldFlow = flowOf([step('a'), step('b', ['a'])]);
  const edited = { ...step('a'), agent: 'architect' };
  const newFlow = flowOf([edited, step('b', ['a'])]);
  const run = runOf(oldFlow, { a: { completionStatus: 'done' } });

  const impact = assessFlowEdit(oldFlow, newFlow, run);

  assert.equal(impact.safe, false);
  assert.deepEqual(impact.changes, [{ stepId: 'a', kind: 'modified', blocking: true }]);
});

test('removing a step that never ran is safe and reported', () => {
  const oldFlow = flowOf([step('a'), step('b', ['a']), step('c', ['b'])]);
  const newFlow = flowOf([step('a'), step('b', ['a'])]);
  const run = runOf(oldFlow, { a: { completionStatus: 'done' } });

  const impact = assessFlowEdit(oldFlow, newFlow, run);

  assert.equal(impact.safe, true);
  assert.deepEqual(impact.removedStepIds, ['c']);
});

test('removing the running step is blocking', () => {
  const oldFlow = flowOf([step('a'), step('b', ['a'])]);
  const newFlow = flowOf([step('a')]);
  const run = runOf(oldFlow, { a: { completionStatus: 'done' }, b: { executionStatus: 'running' } });

  assert.equal(assessFlowEdit(oldFlow, newFlow, run).safe, false);
});

test('repointing dependsOn of a not-yet-started step is safe', () => {
  const oldFlow = flowOf([step('a'), step('b', ['a']), step('c', ['a'])]);
  const newFlow = flowOf([step('a'), step('b', ['a']), step('c', ['b'])]);
  const run = runOf(oldFlow, { a: { completionStatus: 'done' } });

  assert.equal(assessFlowEdit(oldFlow, newFlow, run).safe, true);
});

test('renaming the flow is blocking once a step has progressed, safe before that', () => {
  const oldFlow = flowOf([step('a')]);
  const newFlow = flowOf([step('a')], { name: 'Flow Renamed' });

  const started = runOf(oldFlow, { a: { completionStatus: 'done' } });
  const impactStarted = assessFlowEdit(oldFlow, newFlow, started);
  assert.equal(impactStarted.safe, false);
  assert.deepEqual(impactStarted.blockingFlowFields, ['name']);

  const untouched = runOf(oldFlow);
  assert.equal(assessFlowEdit(oldFlow, newFlow, untouched).safe, true);
});

test('changing flow inputs or trustLevel is blocking once a step has progressed', () => {
  const oldFlow = flowOf([step('a')]);
  const run = runOf(oldFlow, { a: { completionStatus: 'done' } });

  const withInputs = flowOf([step('a')], { inputs: { level: { type: 'string', required: true, label: 'Level' } } });
  assert.deepEqual(assessFlowEdit(oldFlow, withInputs, run).blockingFlowFields, ['inputs']);

  const withTrust = flowOf([step('a')], { trustLevel: 'sandboxed' });
  assert.deepEqual(assessFlowEdit(oldFlow, withTrust, run).blockingFlowFields, ['trustLevel']);
});

test('description and aiConversation changes are always safe', () => {
  const oldFlow = flowOf([step('a')]);
  const newFlow = flowOf([step('a')], { description: 'new words', aiConversation: [{ role: 'user', content: 'hi' }] });
  const run = runOf(oldFlow, { a: { completionStatus: 'done' } });

  assert.equal(assessFlowEdit(oldFlow, newFlow, run).safe, true);
});

test('a run with nothing progressed accepts any edit', () => {
  const oldFlow = flowOf([step('a'), step('b', ['a'])]);
  const newFlow = flowOf([{ ...step('a'), agent: 'architect' }, step('x'), step('b', ['x'])], { name: 'Renamed' });
  const run = runOf(oldFlow);

  assert.equal(assessFlowEdit(oldFlow, newFlow, run).safe, true);
});
