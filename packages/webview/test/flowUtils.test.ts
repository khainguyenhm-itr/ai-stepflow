import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getStepSkills,
  hasDependencyCycle,
  getFlowColumns,
  getDefaultActiveStepId,
  hasUnfinishedSteps,
  formatRunTime
} from '../src/flowUtils.js';

/** Minimal flow-step factory; cast to the real type without filling every field. */
const step = (id: string, extra: Record<string, unknown> = {}): any => ({
  id, title: id, agent: 'a', skill: '', review: { required: false }, completion: { requireMarkDone: false }, ...extra
});
const flow = (steps: any[]): any => ({ id: 'f', name: 'f', description: '', inputs: {}, sourcePath: '/f.yaml', steps });
const runState = (steps: Record<string, any>): any => ({ flowId: 'f', runId: 'r', source: '', projectPath: '', inputs: {}, steps });

test('getStepSkills prefers skills[], falls back to skill, empty when neither', () => {
  assert.deepEqual(getStepSkills(step('s', { skills: ['x', 'y'] })), ['x', 'y']);
  assert.deepEqual(getStepSkills(step('s', { skill: 'only' })), ['only']);
  assert.deepEqual(getStepSkills(step('s', { skills: [], skill: '' })), []);
});

test('hasDependencyCycle detects cycles and accepts DAGs', () => {
  // a → b → a is a cycle
  assert.equal(hasDependencyCycle([step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })]), true);
  // self-loop
  assert.equal(hasDependencyCycle([step('a', { dependsOn: ['a'] })]), true);
  // a → b → c is acyclic
  assert.equal(hasDependencyCycle([step('a'), step('b', { dependsOn: ['a'] }), step('c', { dependsOn: ['b'] })]), false);
  // dependency on a non-existent step is ignored, not a cycle
  assert.equal(hasDependencyCycle([step('a', { dependsOn: ['ghost'] })]), false);
});

test('getFlowColumns lays steps out by dependency depth', () => {
  // No dependencies → one step per column, original order.
  const flat = getFlowColumns(flow([step('a'), step('b')]));
  assert.deepEqual(flat.map(col => col.map(s => s.id)), [['a'], ['b']]);

  // Diamond: a → {b, c} → d  ⇒  depth columns [[a], [b, c], [d]].
  const diamond = getFlowColumns(flow([
    step('a'),
    step('b', { dependsOn: ['a'] }),
    step('c', { dependsOn: ['a'] }),
    step('d', { dependsOn: ['b', 'c'] })
  ]));
  assert.deepEqual(diamond.map(col => col.map(s => s.id)), [['a'], ['b', 'c'], ['d']]);
});

test('getDefaultActiveStepId: running wins, else first unfinished, else last', () => {
  const f = flow([step('a'), step('b'), step('c')]);
  // 'b' running → 'b'
  assert.equal(getDefaultActiveStepId(f, runState({
    a: { executionStatus: 'completed', completionStatus: 'done' },
    b: { executionStatus: 'running', completionStatus: 'not_ready' },
    c: { executionStatus: 'ready', completionStatus: 'not_ready' }
  })), 'b');
  // none running → first not-done ('c')
  assert.equal(getDefaultActiveStepId(f, runState({
    a: { executionStatus: 'completed', completionStatus: 'done' },
    b: { executionStatus: 'completed', completionStatus: 'done' },
    c: { executionStatus: 'ready', completionStatus: 'not_ready' }
  })), 'c');
  // all done → last step
  assert.equal(getDefaultActiveStepId(f, runState({
    a: { completionStatus: 'done' }, b: { completionStatus: 'done' }, c: { completionStatus: 'done' }
  })), 'c');
  // empty flow → null
  assert.equal(getDefaultActiveStepId(flow([]), runState({})), null);
});

test('hasUnfinishedSteps is true unless every step is done', () => {
  assert.equal(hasUnfinishedSteps(runState({ a: { completionStatus: 'done' }, b: { completionStatus: 'not_ready' } })), true);
  assert.equal(hasUnfinishedSteps(runState({ a: { completionStatus: 'done' }, b: { completionStatus: 'done' } })), false);
});

test('formatRunTime returns the input unchanged for an unparseable timestamp', () => {
  assert.equal(formatRunTime('not-a-date'), 'not-a-date');
});
