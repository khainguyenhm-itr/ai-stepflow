import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Flow,
  initRunState, markCompleted, markRunning, applyAiReview,
  FlowOrchestrator
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
