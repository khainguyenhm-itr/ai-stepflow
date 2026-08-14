import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Flow,
  initRunState, markCompleted, markRunning, applyAiReview,
  FlowOrchestrator, stepRunIfSatisfied
} from '@claudesteps/core';

// Every step is reviewed; the default is auto (AI) review.
function step(id: string, extra: Record<string, any> = {}) {
  return {
    id, title: id, agent: 'a', skill: 's',
    review: { required: true, type: 'ai' },
    ...extra
  } as any;
}

// Drive a step run → complete → AI-approve so it reaches 'done'.
function toDone(st: any, fl: Flow, id: string) {
  return applyAiReview(markCompleted(markRunning(st, fl, id), fl, id), fl, id, 'approved');
}

test('stepRunIfSatisfied: no condition always runs', () => {
  assert.equal(stepRunIfSatisfied(step('a'), { level: '1' }), true);
  assert.equal(stepRunIfSatisfied(step('a'), {}), true);
});

test('stepRunIfSatisfied: equals does exact string match', () => {
  const s = step('a', { runIf: { input: 'level', equals: '2' } });
  assert.equal(stepRunIfSatisfied(s, { level: '2' }), true);
  assert.equal(stepRunIfSatisfied(s, { level: '1' }), false);
  assert.equal(stepRunIfSatisfied(s, {}), false);
});

test('stepRunIfSatisfied: min/max is an inclusive numeric range', () => {
  const s = step('a', { runIf: { input: 'level', min: 2, max: 3 } });
  assert.equal(stepRunIfSatisfied(s, { level: '1' }), false);
  assert.equal(stepRunIfSatisfied(s, { level: '2' }), true);
  assert.equal(stepRunIfSatisfied(s, { level: '3' }), true);
  assert.equal(stepRunIfSatisfied(s, { level: '4' }), false);
});

test('stepRunIfSatisfied: non-numeric value against min/max fails closed (skips)', () => {
  const s = step('a', { runIf: { input: 'level', min: 2 } });
  assert.equal(stepRunIfSatisfied(s, { level: 'oops' }), false);
  assert.equal(stepRunIfSatisfied(s, {}), false);
});

test('stepRunIfSatisfied: an empty string value fails closed too — Number("") is 0, not NaN', () => {
  // A max-only condition is the case that would otherwise be fooled: 0 <= 5 "passes" the check
  // even though there was never a real value to evaluate.
  const s = step('a', { runIf: { input: 'level', max: 5 } });
  assert.equal(stepRunIfSatisfied(s, { level: '' }), false);
  assert.equal(stepRunIfSatisfied(s, { level: '  ' }), false);
});

test('FlowOrchestrator identifies ready steps and respects interactive limits', () => {
  const flow: Flow = {
    id: 'f', name: 'f', description: '', inputs: {}, sourcePath: '/f.yaml',
    steps: [
      step('a'),
      step('b', { dependsOn: ['a'], review: { required: true, type: 'ai' } }), // AI review, still interactive
      step('c', { dependsOn: ['a'] }),
      step('d', { dependsOn: ['a'] })
    ]
  };

  let st = initRunState(flow, { runId: 'r1' });
  let orch = new FlowOrchestrator(flow, st);

  // Initially only 'a' is ready, but it's a root step so auto-advance doesn't pick it
  assert.deepEqual(orch.getAutoAdvanceActions(), []);

  // Complete and approve 'a' so its dependents unlock
  st = toDone(st, flow, 'a');
  orch = new FlowOrchestrator(flow, st);

  // Every step runs interactively (AI review only changes post-run verify, not launch mode).
  // Of the three ready steps, exactly one launches and the rest are parked.
  const actions = orch.getAutoAdvanceActions();
  assert.equal(actions.length, 3);
  assert.equal(actions.filter(a => a.type === 'launch_interactive').length, 1);
  assert.equal(actions.filter(a => a.type === 'park_interactive').length, 2);
  assert.ok(!actions.some(a => a.type === 'launch_headless'));
});

test('FlowOrchestrator does not re-launch already started steps', () => {
  const flow: Flow = {
    id: 'f', name: 'f', description: '', inputs: {}, sourcePath: '/f.yaml',
    steps: [
      step('a'),
      step('b', { dependsOn: ['a'] })
    ]
  };

  let st = initRunState(flow, { runId: 'r1' });
  st = toDone(st, flow, 'a');

  const orch = new FlowOrchestrator(flow, st);
  const actions1 = orch.getAutoAdvanceActions();
  assert.equal(actions1.length, 1);
  assert.equal(actions1[0].stepId, 'b');

  // If we simulate a re-advance without updating state (e.g. step is still 'ready'),
  // the orchestrator should NOT return 'b' again because it's already tracked as started
  // in the instance.
  const actions2 = orch.getAutoAdvanceActions();
  assert.equal(actions2.length, 0);
});

test('FlowOrchestrator skips a ROOT step whose runIf does not match — roots are normally excluded from auto-advance, but skip must still apply', () => {
  const flow: Flow = {
    id: 'f', name: 'f', description: '', inputs: {}, sourcePath: '/f.yaml',
    steps: [step('a', { runIf: { input: 'level', equals: '2' } })]
  };
  const st = initRunState(flow, { runId: 'r1', inputs: { level: '1' } });
  const orch = new FlowOrchestrator(flow, st);
  const actions = orch.getAutoAdvanceActions();
  assert.deepEqual(actions, [{ type: 'skip', stepId: 'a' }]);
});

test('FlowOrchestrator skips a dependent step whose runIf does not match, instead of launching it', () => {
  const flow: Flow = {
    id: 'f', name: 'f', description: '', inputs: {}, sourcePath: '/f.yaml',
    steps: [
      step('a'),
      step('b', { dependsOn: ['a'], runIf: { input: 'level', equals: '2' } })
    ]
  };
  let st = initRunState(flow, { runId: 'r1', inputs: { level: '1' } });
  st = toDone(st, flow, 'a');
  const orch = new FlowOrchestrator(flow, st);
  const actions = orch.getAutoAdvanceActions();
  assert.deepEqual(actions, [{ type: 'skip', stepId: 'b' }]);
});

test('FlowOrchestrator does not skip or re-skip a step whose runIf matches', () => {
  const flow: Flow = {
    id: 'f', name: 'f', description: '', inputs: {}, sourcePath: '/f.yaml',
    steps: [step('a', { runIf: { input: 'level', equals: '1' } })]
  };
  const st = initRunState(flow, { runId: 'r1', inputs: { level: '1' } });
  const orch = new FlowOrchestrator(flow, st);
  // Root step, matches runIf → not a skip candidate; roots stay excluded from auto-launch too,
  // so no action at all (same as a plain root step with no runIf).
  assert.deepEqual(orch.getAutoAdvanceActions(), []);
});

// ---------------------------------------------------------------------------
// getRunIfSkipActions — the runIf-only sweep.
//
// Opening the cockpit must resolve `runIf` gates WITHOUT launching anything: a launch is a
// side effect the user did not ask for, and it hijacks the step's terminal so the user's own
// "Run Step" click can no longer open a clean session.
// ---------------------------------------------------------------------------

test('getRunIfSkipActions never launches: a ready dependent step yields no action', () => {
  const flow: Flow = {
    id: 'f', name: 'f', description: '', inputs: {}, sourcePath: '/f.yaml',
    steps: [step('a'), step('b', { dependsOn: ['a'] })]
  };
  let st = initRunState(flow, { runId: 'r1', inputs: {} });
  st = toDone(st, flow, 'a');

  // Proof the step really is launchable — otherwise this test would pass vacuously.
  assert.deepEqual(
    new FlowOrchestrator(flow, st).getAutoAdvanceActions(),
    [{ type: 'launch_interactive', stepId: 'b' }]
  );
  assert.deepEqual(new FlowOrchestrator(flow, st).getRunIfSkipActions(), []);
});

test('getRunIfSkipActions never parks: two ready dependents yield no action', () => {
  const flow: Flow = {
    id: 'f', name: 'f', description: '', inputs: {}, sourcePath: '/f.yaml',
    steps: [step('a'), step('b', { dependsOn: ['a'] }), step('c', { dependsOn: ['a'] })]
  };
  let st = initRunState(flow, { runId: 'r1', inputs: {} });
  st = toDone(st, flow, 'a');
  assert.deepEqual(new FlowOrchestrator(flow, st).getRunIfSkipActions(), []);
});

test('getRunIfSkipActions still skips a ROOT step whose runIf does not match', () => {
  const flow: Flow = {
    id: 'f', name: 'f', description: '', inputs: {}, sourcePath: '/f.yaml',
    steps: [step('a', { runIf: { input: 'level', equals: '2' } })]
  };
  const st = initRunState(flow, { runId: 'r1', inputs: { level: '1' } });
  assert.deepEqual(
    new FlowOrchestrator(flow, st).getRunIfSkipActions(),
    [{ type: 'skip', stepId: 'a' }]
  );
});

test('getRunIfSkipActions skips a ready dependent whose runIf does not match, without launching its ready sibling', () => {
  const flow: Flow = {
    id: 'f', name: 'f', description: '', inputs: {}, sourcePath: '/f.yaml',
    steps: [
      step('a'),
      step('b', { dependsOn: ['a'], runIf: { input: 'level', equals: '2' } }),
      step('c', { dependsOn: ['a'] })
    ]
  };
  let st = initRunState(flow, { runId: 'r1', inputs: { level: '1' } });
  st = toDone(st, flow, 'a');
  assert.deepEqual(
    new FlowOrchestrator(flow, st).getRunIfSkipActions(),
    [{ type: 'skip', stepId: 'b' }]
  );
});
