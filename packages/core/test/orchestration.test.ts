import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Flow, FlowStep, FlowRunState, StepRunState,
  initRunState, markRunning, markCompleted, applyAiReview, markDone, doneStepIds,
  pickAutoAdvanceStep, seedStartedSteps,
  reviewStepArtifacts, ReviewResult,
  ClaudeStreamingRunResult, ClaudeStreamingRunOptions
} from '@ai-stepflow/core';

function step(id: string, extra: Record<string, unknown> = {}): FlowStep {
  return { id, title: id, agent: 'a', skill: 's', review: { required: false }, completion: { requireMarkDone: false }, ...extra } as FlowStep;
}

function flowOf(steps: FlowStep[]): Flow {
  return { id: 'f', name: 'f', description: '', inputs: {}, sourcePath: '/f.yaml', steps };
}

/** A StepRunner stub that never spawns `claude`; it just echoes a canned result. */
function stubRunner(resultText: string, success = true) {
  return async (_opts: ClaudeStreamingRunOptions): Promise<ClaudeStreamingRunResult> =>
    ({ success, exitCode: success ? 0 : 1, resultText });
}

// ---------------------------------------------------------------------------
// pickAutoAdvanceStep — the "auto-advance only when exactly one is ready" rule.
// ---------------------------------------------------------------------------

test('pickAutoAdvanceStep returns the single unlocked dependent', () => {
  const steps = [step('a'), step('b', { dependsOn: ['a'] })];
  assert.equal(pickAutoAdvanceStep(steps, new Set(['a']), new Set()), 'b');
});

test('pickAutoAdvanceStep returns undefined when a fan-out unlocks several at once', () => {
  const steps = [step('a'), step('b', { dependsOn: ['a'] }), step('c', { dependsOn: ['a'] })];
  assert.equal(pickAutoAdvanceStep(steps, new Set(['a']), new Set()), undefined);
});

test('pickAutoAdvanceStep returns undefined when nothing is ready', () => {
  const steps = [step('a'), step('b', { dependsOn: ['a'] })];
  // 'a' not done yet → 'b' still locked.
  assert.equal(pickAutoAdvanceStep(steps, new Set(), new Set()), undefined);
});

test('pickAutoAdvanceStep skips an already-started dependent', () => {
  const steps = [step('a'), step('b', { dependsOn: ['a'] })];
  assert.equal(pickAutoAdvanceStep(steps, new Set(['a']), new Set(['b'])), undefined);
});

test('pickAutoAdvanceStep never auto-starts a root step (no deps)', () => {
  const steps = [step('a'), step('b')];
  assert.equal(pickAutoAdvanceStep(steps, new Set(), new Set()), undefined);
});

// ---------------------------------------------------------------------------
// seedStartedSteps — restoring a run must not re-run steps that already ran.
// ---------------------------------------------------------------------------

test('seedStartedSteps treats pristine ready/locked steps as not started', () => {
  const steps: Record<string, StepRunState> = {
    a: { executionStatus: 'ready', reviewStatus: 'not_required', completionStatus: 'not_ready' },
    b: { executionStatus: 'locked', reviewStatus: 'not_required', completionStatus: 'not_ready' }
  };
  assert.deepEqual([...seedStartedSteps(steps)], []);
});

test('seedStartedSteps treats any non-pristine step as started', () => {
  const steps: Record<string, StepRunState> = {
    a: { executionStatus: 'completed', reviewStatus: 'not_required', completionStatus: 'done' },
    b: { executionStatus: 'running', reviewStatus: 'not_required', completionStatus: 'not_ready' },
    c: { executionStatus: 'completed', reviewStatus: 'pending', completionStatus: 'not_ready' }, // parked at review gate
    d: { executionStatus: 'ready', reviewStatus: 'not_required', completionStatus: 'not_ready' }  // pristine
  };
  assert.deepEqual([...seedStartedSteps(steps)].sort(), ['a', 'b', 'c']);
});

// ---------------------------------------------------------------------------
// reviewStepArtifacts — the injected-runner verdict parsing (no `claude`, no fs).
// ---------------------------------------------------------------------------

const reviewStep = step('r', { review: { required: true, type: 'ai' }, produces: ['out.md'] });

async function review(resultText: string, deep = true): Promise<ReviewResult> {
  const flow = flowOf([reviewStep]);
  const runState = initRunState(flow, { runId: 'r1' });
  return reviewStepArtifacts({
    workspaceRoot: '/nonexistent', // forces the default validator to be "missing" → skip layer 1
    step: reviewStep,
    runState,
    deep,
    reviewKit: 'REVIEW KIT',
    artifacts: { text: 'some artifact text', count: 1 },
    runner: stubRunner(resultText)
  });
}

test('reviewStepArtifacts approves on a pass verdict from the LLM', async () => {
  const r = await review('{"decision":"pass","reason":"looks good"}');
  assert.equal(r.status, 'approved');
  assert.equal(r.source, 'llm');
});

test('reviewStepArtifacts rejects on a reject verdict from the LLM', async () => {
  const r = await review('{"decision":"reject","reason":"missing tests"}');
  assert.equal(r.status, 'rejected');
  assert.equal(r.source, 'llm');
  assert.match(r.note, /missing tests/);
});

test('reviewStepArtifacts waits for a human when the verdict cannot be parsed', async () => {
  const r = await review('I think this is probably fine, ship it');
  assert.equal(r.status, 'waiting_human');
});

test('reviewStepArtifacts is validator-only when deep review is disabled', async () => {
  const r = await review('{"decision":"reject"}', false);
  // Missing default validator => skip layer 1; deep disabled => approve without an LLM call.
  assert.equal(r.status, 'approved');
  assert.equal(r.source, 'validator-only');
});

// ---------------------------------------------------------------------------
// End-to-end orchestration loop — compose the primitives the way the host does.
// ---------------------------------------------------------------------------

/**
 * Drive a flow to completion using only core primitives + a stub reviewer, mirroring
 * the headless AI-review path in the extension/CLI: run a step, complete it, review it,
 * apply the verdict, then auto-advance the single unlocked dependent.
 */
async function driveHeadless(flow: Flow, verdicts: Record<string, string>): Promise<FlowRunState> {
  let st = initRunState(flow, { runId: 'r1' });
  const started = new Set<string>();
  const order: string[] = [];

  const runStep = async (id: string): Promise<void> => {
    const step = flow.steps.find(s => s.id === id)!;
    started.add(id);
    order.push(id);
    st = markRunning(st, flow, id);
    st = markCompleted(st, flow, id, { output: 'done' });
    if (step.review.required) {
      const r = await reviewStepArtifacts({
        workspaceRoot: '/nonexistent', step, runState: st, deep: true,
        reviewKit: 'KIT', artifacts: { text: 'art', count: 1 },
        runner: stubRunner(verdicts[id] ?? '{"decision":"pass"}')
      });
      st = applyAiReview(st, flow, id, r.status as 'approved' | 'rejected', r.note);
      if (r.status !== 'approved') return; // rejected → step is back to ready, stop the chain
    } else {
      st = markDone(st, flow, id);
    }
    const next = pickAutoAdvanceStep(flow.steps, doneStepIds(st), started);
    if (next) await runStep(next);
  };

  // Kick off the root step (the host launches roots by hand).
  await runStep(flow.steps[0].id);
  (st as FlowRunState & { _order?: string[] })._order = order;
  return st;
}

test('a linear DAG runs every step in dependency order and finishes done', async () => {
  const flow = flowOf([
    step('a'),
    step('b', { dependsOn: ['a'], review: { required: true, type: 'ai' }, produces: ['b.md'] }),
    step('c', { dependsOn: ['b'] })
  ]);
  const st = await driveHeadless(flow, { b: '{"decision":"pass"}' });
  assert.deepEqual((st as any)._order, ['a', 'b', 'c']);
  for (const id of ['a', 'b', 'c']) assert.equal(st.steps[id].completionStatus, 'done', `${id} should be done`);
});

test('an AI rejection parks the step back at ready and halts the chain', async () => {
  const flow = flowOf([
    step('a'),
    step('b', { dependsOn: ['a'], review: { required: true, type: 'ai' }, produces: ['b.md'] }),
    step('c', { dependsOn: ['b'] })
  ]);
  const st = await driveHeadless(flow, { b: '{"decision":"reject","reason":"nope"}' });
  assert.equal(st.steps.b.reviewStatus, 'rejected');
  assert.equal(st.steps.b.executionStatus, 'ready');     // sent back to ready for a rerun
  assert.equal(st.steps.b.completionStatus, 'not_ready');
  assert.equal(st.steps.c.completionStatus, 'not_ready'); // dependent never started
  assert.equal(st.steps.c.executionStatus, 'locked');
});

test('a fan-out does not auto-advance; both dependents wait for the user', async () => {
  const flow = flowOf([
    step('a'),
    step('b', { dependsOn: ['a'] }),
    step('c', { dependsOn: ['a'] })
  ]);
  const st = await driveHeadless(flow, {});
  // 'a' ran and is done; 'b' and 'c' unlocked together so neither auto-started.
  assert.equal(st.steps.a.completionStatus, 'done');
  assert.deepEqual((st as any)._order, ['a']);
  assert.equal(st.steps.b.executionStatus, 'ready');
  assert.equal(st.steps.c.executionStatus, 'ready');
});
