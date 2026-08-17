# Mid-run Workflow Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saving an edited workflow while one of its runs is live either reconciles every live run with the new flow (when the edit only touches work that has not started) or, after an explicit modal confirmation, resets those runs; cancelling the modal leaves the flow unsaved.

**Architecture:** A new pure module in `packages/core` classifies the edit against a run's state using the `dependsOn` DAG. `RunOrchestrator` gains four methods — assess+confirm, reconcile, reset-all — and `CockpitPanel`'s `saveFlow` handler becomes a thin composition of them. The webview gains one new host message so a cancelled save reopens the builder with the user's draft.

**Tech Stack:** TypeScript, VS Code extension API, React webview, `node --test` (no test framework beyond node's builtin), npm workspaces (`@claudesteps/core`).

**Spec:** `docs/superpowers/specs/2026-08-17-mid-run-workflow-edit-design.md`

## Global Constraints

- No `vscode` import may appear in `packages/core` — it is compiled and unit-tested outside the extension host.
- Tests are `node:test` + `node:assert/strict`. No new test dependency.
- Core tests live in `packages/core/test/*.test.ts`, run by `npm run test:unit`.
- Extension unit tests live in `packages/extension/test/unit/*.test.ts`, run by `npm run test:unit-ext`; they import `./vscodeStub.js` for the `vscode` API.
- Webview tests live in `packages/webview/test/*.test.ts`, run by `npm run test:webview`, and may only import pure modules (no React rendering harness exists).
- Every new exported symbol in `packages/core/src` must be re-exported by `packages/core/src/index.ts` (the file is a flat list of `export * from './x.js';`).
- Relative imports inside the packages use the `.js` extension even from `.ts` sources (NodeNext resolution).
- Work on the existing branch `feat/mid-run-workflow-edit`.

---

### Task 1: Core edit-impact classifier

**Files:**
- Create: `packages/core/src/flowEditImpact.ts`
- Modify: `packages/core/src/index.ts` (add one export line)
- Test: `packages/core/test/flowEditImpact.test.ts`

**Interfaces:**
- Consumes: `Flow`, `FlowStep`, `FlowRunState`, `StepRunState` from `./types.js`.
- Produces:
  - `stepProgressed(state: StepRunState | undefined): boolean`
  - `assessFlowEdit(oldFlow: Flow, newFlow: Flow, runState: FlowRunState): FlowEditImpact`
  - `interface StepChange { stepId: string; kind: 'added' | 'removed' | 'modified'; blocking: boolean }`
  - `interface FlowEditImpact { changes: StepChange[]; blockingFlowFields: string[]; addedStepIds: string[]; removedStepIds: string[]; safe: boolean }`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/flowEditImpact.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:unit`
Expected: compile error / FAIL — `Cannot find module '../src/flowEditImpact.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/flowEditImpact.ts`:

```ts
import { Flow, FlowRunState, FlowStep, StepRunState } from './types.js';

/**
 * Classifies an edit to a flow against a run that is already live. The rule the whole feature
 * turns on: an edit is safe only when it cannot invalidate work the run has already consumed —
 * measured over the `dependsOn` DAG, never over the step array's order.
 */

export type StepChangeKind = 'added' | 'removed' | 'modified';

export interface StepChange {
  stepId: string;
  kind: StepChangeKind;
  /** True when this change lands on work the run has already consumed. */
  blocking: boolean;
}

export interface FlowEditImpact {
  changes: StepChange[];
  /** Flow-level fields whose change invalidates work already produced (`name`, `inputs`, `trustLevel`). */
  blockingFlowFields: string[];
  addedStepIds: string[];
  removedStepIds: string[];
  /** True when nothing in this edit touches work the run already consumed. */
  safe: boolean;
}

/** A step that consumed real work: it ran (in any outcome) or it is marked done. */
export function stepProgressed(state: StepRunState | undefined): boolean {
  if (!state) return false;
  if (state.completionStatus === 'done') return true;
  return state.executionStatus === 'running'
    || state.executionStatus === 'completed'
    || state.executionStatus === 'failed'
    || state.executionStatus === 'cancelled'
    || state.executionStatus === 'skipped';
}

/** Key-order-independent structural comparison, so a re-serialized step isn't read as an edit. */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(',')}}`;
}

/**
 * dependsOn edges from BOTH flows. An edit can add or delete an edge, and either direction can
 * make a step upstream of already-consumed work, so the check runs over the union.
 */
function unionDependencies(oldFlow: Flow, newFlow: Flow): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  for (const step of [...oldFlow.steps, ...newFlow.steps]) {
    const merged = new Set([...(deps.get(step.id) ?? []), ...(step.dependsOn ?? [])]);
    deps.set(step.id, [...merged]);
  }
  return deps;
}

/** Every step reachable by walking `dependsOn` upward from `stepId`. */
function ancestorsOf(deps: Map<string, string[]>, stepId: string): Set<string> {
  const seen = new Set<string>();
  const queue = [...(deps.get(stepId) ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(deps.get(id) ?? []));
  }
  return seen;
}

export function assessFlowEdit(oldFlow: Flow, newFlow: Flow, runState: FlowRunState): FlowEditImpact {
  const oldById = new Map(oldFlow.steps.map(s => [s.id, s] as [string, FlowStep]));
  const newById = new Map(newFlow.steps.map(s => [s.id, s] as [string, FlowStep]));

  const addedStepIds = newFlow.steps.filter(s => !oldById.has(s.id)).map(s => s.id);
  const removedStepIds = oldFlow.steps.filter(s => !newById.has(s.id)).map(s => s.id);
  const modifiedStepIds = newFlow.steps
    .filter(s => oldById.has(s.id) && stableKey(oldById.get(s.id)) !== stableKey(s))
    .map(s => s.id);

  // Steps whose result the run already owns, plus everything upstream of them: touching any of
  // these invalidates work that has been consumed.
  const deps = unionDependencies(oldFlow, newFlow);
  const progressedIds = Object.keys(runState.steps).filter(id => stepProgressed(runState.steps[id]));
  const consumed = new Set(progressedIds);
  for (const id of progressedIds) for (const ancestor of ancestorsOf(deps, id)) consumed.add(ancestor);

  const changes: StepChange[] = [
    ...addedStepIds.map(stepId => ({ stepId, kind: 'added' as const })),
    ...removedStepIds.map(stepId => ({ stepId, kind: 'removed' as const })),
    ...modifiedStepIds.map(stepId => ({ stepId, kind: 'modified' as const })),
  ].map(change => ({ ...change, blocking: consumed.has(change.stepId) }));

  // Flow-level fields that reshape a live run: `name` drives the artifact output directory,
  // `inputs` and `trustLevel` drive runIf gating, path templates and sandboxing.
  const blockingFlowFields: string[] = [];
  if (progressedIds.length > 0) {
    if (oldFlow.name !== newFlow.name) blockingFlowFields.push('name');
    if (stableKey(oldFlow.inputs) !== stableKey(newFlow.inputs)) blockingFlowFields.push('inputs');
    if (oldFlow.trustLevel !== newFlow.trustLevel) blockingFlowFields.push('trustLevel');
  }

  return {
    changes,
    blockingFlowFields,
    addedStepIds,
    removedStepIds,
    safe: blockingFlowFields.length === 0 && changes.every(c => !c.blocking),
  };
}
```

Add to `packages/core/src/index.ts`, after the `runStateMachine` line:

```ts
export * from './flowEditImpact.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:unit`
Expected: PASS, all `flowEditImpact` tests green and no existing core test broken.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/flowEditImpact.ts packages/core/src/index.ts packages/core/test/flowEditImpact.test.ts
git commit -m "feat(core): classify a flow edit against a live run's progress"
```

---

### Task 2: Reconcile live runs with a safe edit

**Files:**
- Modify: `packages/extension/src/runOrchestrator.ts` (add `liveRunsOfFlow` + `syncFlowIntoLiveRuns`, near `resetRun` at line 492)
- Test: `packages/extension/test/unit/runOrchestrator.test.ts` (append tests)

**Interfaces:**
- Consumes: `assessFlowEdit` is NOT used here — this method assumes the caller already decided the edit is safe. Uses `machine.applyDependencyLocks` and `machine.initRunState`'s step shape.
- Produces:
  - `RunOrchestrator.syncFlowIntoLiveRuns(newFlow: Flow): Promise<void>`
  - `private _liveRunsOfFlow(flowId: string): [string, RunCtx][]`

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/test/unit/runOrchestrator.test.ts`. Note `makeFlow` in that file builds a single-step flow; these tests build their own multi-step flows:

```ts
// ---------------------------------------------------------------------------
// Mid-run workflow edits
// ---------------------------------------------------------------------------

/** A flow with the given step ids chained a → b → c, so dependency locks are exercised. */
function makeChainFlow(id: string, stepIds: string[]): Flow {
  return {
    id,
    name: id,
    description: '',
    inputs: {},
    steps: stepIds.map((sid, i) => ({
      id: sid, title: sid, agent: 'po', skill: 'prd',
      dependsOn: i === 0 ? undefined : [stepIds[i - 1]],
      review: { required: true, type: 'human' },
    })),
    sourcePath: `/repo/.claudesteps/flows/${id}.yaml`,
  } as Flow;
}

test('syncing a safe edit adds the new step to every live run and re-applies locks', async () => {
  const { orch, saved } = build();
  const flow = makeChainFlow('f1', ['a', 'b']);
  const run = makeRun(flow, 'run-1', projectPath);
  run.steps.a = { ...run.steps.a, completionStatus: 'done' };
  orch.setFlowAndRunState(flow, run);

  await orch.syncFlowIntoLiveRuns(makeChainFlow('f1', ['a', 'b', 'c']));

  const state = orch.runState!;
  assert.ok(state.steps.c, 'new step present in run state');
  assert.equal(state.steps.c.executionStatus, 'locked'); // depends on b, which is not done
  assert.equal(state.steps.a.completionStatus, 'done', 'existing progress preserved');
  assert.equal(orch.currentFlow?.steps.length, 3, 'in-memory flow replaced');
  assert.ok(saved.some(s => s.runId === 'run-1' && !!s.steps.c), 'run file persisted');
});

test('syncing a safe edit drops a removed step from the run state', async () => {
  const { orch } = build();
  const flow = makeChainFlow('f1', ['a', 'b', 'c']);
  orch.setFlowAndRunState(flow, makeRun(flow, 'run-1', projectPath));

  await orch.syncFlowIntoLiveRuns(makeChainFlow('f1', ['a', 'b']));

  assert.equal(orch.runState!.steps.c, undefined);
  assert.deepEqual(Object.keys(orch.runState!.steps).sort(), ['a', 'b']);
});

test('syncing an edit leaves runs of other flows untouched', async () => {
  const { orch } = build();
  const flowA = makeChainFlow('f1', ['a']);
  const flowB = makeChainFlow('f2', ['a']);
  orch.setFlowAndRunState(flowB, makeRun(flowB, 'run-B', projectPath));
  orch.setFlowAndRunState(flowA, makeRun(flowA, 'run-A', projectPath));

  await orch.syncFlowIntoLiveRuns(makeChainFlow('f1', ['a', 'b']));

  orch.setFlowAndRunState(flowB, undefined);
  assert.equal(orch.currentFlow?.id, 'f2');
  // run-B never gained the new step
  const bStates = posted.filter(m => m.type === 'runStateChanged' && (m as any).runState.runId === 'run-B');
  assert.equal(bStates.length, 0);
});

test('syncing an edit refreshes the focused run view with the new flow', async () => {
  const { orch } = build();
  const flow = makeChainFlow('f1', ['a']);
  orch.setFlowAndRunState(flow, makeRun(flow, 'run-1', projectPath));

  await orch.syncFlowIntoLiveRuns(makeChainFlow('f1', ['a', 'b']));

  const restore = posted.filter(m => m.type === 'restoreRun');
  assert.equal(restore.length, 1);
  assert.equal((restore[0] as any).flow.steps.length, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:unit-ext`
Expected: compile error — `Property 'syncFlowIntoLiveRuns' does not exist on type 'RunOrchestrator'`.

- [ ] **Step 3: Write the implementation**

In `packages/extension/src/runOrchestrator.ts`, insert directly above `async resetRun(` (line 492):

```ts
  /** Every run of `flowId` still live in this session (closed runs are already out of `_runs`). */
  private _liveRunsOfFlow(flowId: string): [string, RunCtx][] {
    return [...this._runs].filter(([, rc]) => rc.flow.id === flowId && !rc.runState.isClosed);
  }

  /**
   * Adopt an edited flow into every live run of it, for an edit already classified safe (it only
   * touches steps the run has not consumed — see `assessFlowEdit`). Added steps join the run as
   * fresh, removed steps are erased from the state and from this run's bookkeeping, and dependency
   * locks are recomputed so the DAG reflects the new edges.
   */
  async syncFlowIntoLiveRuns(newFlow: Flow): Promise<void> {
    for (const [runId, rc] of this._liveRunsOfFlow(newFlow.id)) {
      const removedIds = rc.flow.steps.filter(s => !newFlow.steps.some(n => n.id === s.id)).map(s => s.id);
      rc.flow = newFlow;

      // Bookkeeping is keyed by stepId; a removed step must not leave entries behind that a later
      // step with the same id would inherit.
      for (const id of removedIds) {
        rc.startedStepIds.delete(id);
        rc.parkedStepIds.delete(id);
        rc.autoRetryStepIds.delete(id);
        rc.stepStartTimes.delete(id);
        rc.readinessSnapshots.delete(id);
        rc.outputChunkBuffer.delete(id);
        this._cancelledStepIds.delete(this._rk(runId, id));
      }

      await this._setRunState(runId, prev => {
        const steps: Record<string, StepRunState> = {};
        for (const step of newFlow.steps) {
          steps[step.id] = prev.steps[step.id] ?? {
            executionStatus: 'ready',
            reviewStatus: 'pending',
            completionStatus: 'not_ready',
            output: ''
          };
        }
        return {
          ...prev,
          flowName: newFlow.name,
          source: newFlow.sourcePath,
          steps: machine.applyDependencyLocks(newFlow, steps)
        };
      });

      // The run may have gained unfinished work, so let the completion notice fire again.
      rc.completedNotified = false;

      await Promise.all([
        removedIds.length ? this.stateManager.clearAuditLog(newFlow.id, runId, removedIds) : Promise.resolve(),
        removedIds.length ? this.stateManager.deleteReviewReports(rc.runState, removedIds) : Promise.resolve(),
      ]);

      // `runStateChanged` (posted by _setRunState) keeps background runs current, but the focused
      // view also holds the FLOW — only `restoreRun` refreshes that.
      if (this._focusedRunId === runId) this.post({ type: 'restoreRun', flow: newFlow, runState: rc.runState });

      // A newly added step may be gated by runIf; resolve it now rather than at the next advance.
      this._sweepRunIfSkips(runId);
    }
  }
```

No import changes are needed: `StepRunState`, `FlowStep` and `Flow` are already in the file's named `@claudesteps/core` import (lines 12–22), and `machine` is the namespace import on line 23.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:unit-ext`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/runOrchestrator.ts packages/extension/test/unit/runOrchestrator.test.ts
git commit -m "feat(extension): reconcile live runs with a safe flow edit"
```

---

### Task 3: Reset every live run from the edited flow

**Files:**
- Modify: `packages/extension/src/runOrchestrator.ts` (`_producedFilePaths` line 739, `resetRun` line 492, add `resetRunsForFlow`)
- Test: `packages/extension/test/unit/runOrchestrator.test.ts` (append tests)

**Interfaces:**
- Consumes: `_liveRunsOfFlow` from Task 2.
- Produces:
  - `RunOrchestrator.resetRun(explicitRunId?: string, opts?: { extraSteps?: FlowStep[] }): Promise<void>` — the existing signature gains an optional second parameter; existing call sites are unaffected.
  - `RunOrchestrator.resetRunsForFlow(newFlow: Flow): Promise<void>`

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/test/unit/runOrchestrator.test.ts`:

```ts
test('resetting for an edited flow rebuilds every live run from the new flow', async () => {
  const { orch } = build();
  const flow = makeChainFlow('f1', ['a', 'b']);
  const run = makeRun(flow, 'run-1', projectPath);
  run.steps.a = { ...run.steps.a, completionStatus: 'done', output: 'old work' };
  orch.setFlowAndRunState(flow, run);

  await orch.resetRunsForFlow(makeChainFlow('f1', ['a', 'b', 'c']));

  const state = orch.runState!;
  assert.notEqual(state.runId, 'run-1', 'reset mints a new runId');
  assert.equal(state.steps.a.completionStatus, 'not_ready', 'progress cleared');
  assert.equal(state.steps.a.output, '');
  assert.ok(state.steps.c, 'new step present');
  assert.equal(orch.currentFlow?.steps.length, 3);
});

test('resetting for an edited flow deletes the artifacts of a step the edit removed', async () => {
  const { orch } = build();
  const doomed = path.join(projectPath, 'doomed.md');
  const flow = makeChainFlow('f1', ['a', 'b']);
  flow.steps[1] = { ...flow.steps[1], produces: ['doomed.md'] };
  writeFileSync(doomed, 'artifact from the removed step');
  orch.setFlowAndRunState(flow, makeRun(flow, 'run-1', projectPath));

  await orch.resetRunsForFlow(makeChainFlow('f1', ['a']));

  assert.equal(existsSync(doomed), false, "the removed step's artifact is deleted");
});

test('resetting for an edited flow ignores runs of other flows', async () => {
  const { orch } = build();
  const flowA = makeChainFlow('f1', ['a']);
  const flowB = makeChainFlow('f2', ['a']);
  const runB = makeRun(flowB, 'run-B', projectPath);
  orch.setFlowAndRunState(flowB, runB);
  orch.setFlowAndRunState(flowA, makeRun(flowA, 'run-A', projectPath));

  await orch.resetRunsForFlow(makeChainFlow('f1', ['a', 'b']));

  orch.setFlowAndRunState(flowB, runB);
  assert.equal(orch.runState?.runId, 'run-B', 'the other flow keeps its runId');
});
```

Add `existsSync` to the `node:fs` import at the top of that test file, and `FlowStep` to its `@claudesteps/core` type import if the compiler asks for it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:unit-ext`
Expected: compile error — `Property 'resetRunsForFlow' does not exist on type 'RunOrchestrator'`.

- [ ] **Step 3: Write the implementation**

3a. In `packages/extension/src/runOrchestrator.ts`, widen `_producedFilePaths` (line 739) so it can resolve steps that no longer exist in `rc.flow`:

```ts
  private _producedFilePaths(runId: string, stepIds: string[], extraSteps: FlowStep[] = []): string[] {
    const rc = this._runs.get(runId);
    if (!rc) return [];
    const flow = rc.flow;
    const projectPath = this.configManager.getProjectPath() || '';
    const inputs = rc.runState.inputs || {};
    const slug = this._runSlug(runId);
    const legacySlug = this._legacyRunSlug(runId);
    const paths = new Set<string>();
    for (const id of stepIds) {
      // `extraSteps` carries steps an edit deleted from the flow — their artifacts still exist on
      // disk and a reset must clear them too.
      const step = flow.steps.find(s => s.id === id) ?? extraSteps.find(s => s.id === id);
      if (!step) continue;
      for (const p of machine.resolveTemplates(step.produces, inputs)) {
        paths.add(machine.locateProducedFile(p, flow.name, projectPath, slug, legacySlug));
      }
    }
    return [...paths];
  }
```

3b. Change `resetRun`'s signature and its artifact-gathering lines (492–503):

```ts
  /** Reset a run (targets `explicitRunId`, else the focused run) to a fresh state, terminating its in-flight processes.
   *  `opts.extraSteps` carries steps that a concurrent flow edit removed, so their artifacts are cleared too. */
  async resetRun(explicitRunId?: string, opts: { extraSteps?: FlowStep[] } = {}): Promise<void> {
    const oldRunId = explicitRunId ?? this._focusedRunId;
    const rc = oldRunId ? this._runs.get(oldRunId) : undefined;
    if (!oldRunId || !rc) return;
    const flow = rc.flow;
    const oldSteps = rc.runState.steps;
    const oldRunState = rc.runState;

    // Capture this run's artifacts BEFORE the state swap (reset mints a new runId → new slug).
    const projectPath = this.configManager.getProjectPath() || '';
    const extraSteps = opts.extraSteps ?? [];
    const artifactStepIds = [...new Set([...flow.steps.map(s => s.id), ...extraSteps.map(s => s.id)])];
    const runArtifacts = this._producedFilePaths(oldRunId, artifactStepIds, extraSteps);
```

The rest of `resetRun` is unchanged.

3c. Add `resetRunsForFlow` directly after `resetRun`:

```ts
  /**
   * Reset every live run of `newFlow` so they restart from the edited flow. Used when a mid-run
   * edit touched work the runs had already consumed and the user confirmed the reset.
   */
  async resetRunsForFlow(newFlow: Flow): Promise<void> {
    for (const [runId, rc] of this._liveRunsOfFlow(newFlow.id)) {
      // Steps the edit deleted: gone from the new flow, but their artifacts are still on disk.
      const removedSteps = rc.flow.steps.filter(s => !newFlow.steps.some(n => n.id === s.id));
      rc.flow = newFlow;
      await this.resetRun(runId, { extraSteps: removedSteps });
    }
  }
```

Ensure `FlowStep` is in the file's `@claudesteps/core` import.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:unit-ext`
Expected: PASS, including the pre-existing `resetRun` tests.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/runOrchestrator.ts packages/extension/test/unit/runOrchestrator.test.ts
git commit -m "feat(extension): reset every live run from an edited flow"
```

---

### Task 4: Assess the edit and ask for confirmation

**Files:**
- Modify: `packages/extension/src/runOrchestrator.ts` (add `reviewFlowEdit`)
- Test: `packages/extension/test/unit/runOrchestrator.test.ts` (append tests)

**Interfaces:**
- Consumes: `assessFlowEdit` from Task 1, `_liveRunsOfFlow` from Task 2.
- Produces: `RunOrchestrator.reviewFlowEdit(newFlow: Flow): Promise<'safe' | 'reset' | 'cancelled'>`
  - `'safe'` — no live run is disturbed, or the edit only touches unstarted work. Caller saves, then calls `syncFlowIntoLiveRuns`.
  - `'reset'` — the user confirmed. Caller saves, then calls `resetRunsForFlow`.
  - `'cancelled'` — the user declined. Caller must not save.

- [ ] **Step 1: Write the failing test**

Append to `packages/extension/test/unit/runOrchestrator.test.ts`:

```ts
test('reviewing an edit with no live run is safe without prompting', async () => {
  const { orch } = build();
  assert.equal(await orch.reviewFlowEdit(makeChainFlow('f1', ['a', 'b'])), 'safe');
  assert.equal(recorder.warnMessages.length, 0);
});

test('reviewing an edit that only adds later work is safe without prompting', async () => {
  const { orch } = build();
  const flow = makeChainFlow('f1', ['a', 'b']);
  const run = makeRun(flow, 'run-1', projectPath);
  run.steps.a = { ...run.steps.a, completionStatus: 'done' };
  orch.setFlowAndRunState(flow, run);

  assert.equal(await orch.reviewFlowEdit(makeChainFlow('f1', ['a', 'b', 'c'])), 'safe');
  assert.equal(recorder.warnMessages.length, 0);
});

test('reviewing an edit that touches consumed work warns and reports the confirmation', async () => {
  const { orch } = build();
  const flow = makeChainFlow('f1', ['a', 'b']);
  const run = makeRun(flow, 'run-1', projectPath);
  run.steps.a = { ...run.steps.a, completionStatus: 'done' };
  orch.setFlowAndRunState(flow, run);
  const edited = makeChainFlow('f1', ['a', 'b']);
  edited.steps[0] = { ...edited.steps[0], agent: 'architect' };

  recorder.warnResult = 'Reset & Save';
  assert.equal(await orch.reviewFlowEdit(edited), 'reset');
  assert.equal(recorder.warnMessages.length, 1);

  recorder.warnResult = undefined;
  assert.equal(await orch.reviewFlowEdit(edited), 'cancelled');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:unit-ext`
Expected: compile error — `Property 'reviewFlowEdit' does not exist on type 'RunOrchestrator'`.

- [ ] **Step 3: Write the implementation**

In `packages/extension/src/runOrchestrator.ts`, add before `syncFlowIntoLiveRuns`:

```ts
  /** The confirm button label, exported as a constant so the test and the handler cannot drift. */
  static readonly RESET_AND_SAVE = 'Reset & Save';

  /**
   * Decide what saving `newFlow` means for the runs that are live right now. Safe edits pass
   * straight through; an edit that touches work a run has already consumed asks the user to accept
   * a full reset first, and a declined prompt means the flow must not be written at all.
   */
  async reviewFlowEdit(newFlow: Flow): Promise<'safe' | 'reset' | 'cancelled'> {
    const blocked: string[] = [];
    for (const [, rc] of this._liveRunsOfFlow(newFlow.id)) {
      const impact = machine.assessFlowEdit(rc.flow, newFlow, rc.runState);
      if (impact.safe) continue;
      const stepReasons = impact.changes.filter(c => c.blocking).map(c => `${c.stepId} (${c.kind})`);
      const reasons = [...stepReasons, ...impact.blockingFlowFields.map(f => `flow ${f} changed`)];
      blocked.push(`• ${rc.runState.runName || rc.runState.runId}: ${reasons.join(', ')}`);
    }
    if (blocked.length === 0) return 'safe';

    const choice = await vscode.window.showWarningMessage(
      `'${newFlow.name}' was edited in a part that has already run.`,
      {
        modal: true,
        detail: `${blocked.join('\n')}\n\nSaving requires resetting ${blocked.length === 1 ? 'this run' : 'these runs'}: their artifacts, audit log, report and review reports are deleted and they restart from scratch.`
      },
      RunOrchestrator.RESET_AND_SAVE
    );
    return choice === RunOrchestrator.RESET_AND_SAVE ? 'reset' : 'cancelled';
  }
```

The modal's implicit Cancel button is what VS Code adds itself; do not pass a `'Cancel'` item.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:unit-ext`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/runOrchestrator.ts packages/extension/test/unit/runOrchestrator.test.ts
git commit -m "feat(extension): confirm a mid-run flow edit before resetting runs"
```

---

### Task 5: Wire the save handler and keep the draft on cancel

**Files:**
- Modify: `packages/extension/src/webviewPanel.ts:121-129` (the `saveFlow` case)
- Modify: `packages/extension/src/messages.ts` (add `flowSaveCancelled` to `HostMessage`)
- Modify: `packages/webview/src/hooks/useAppLogic.ts` (handle `flowSaveCancelled`)
- Test: `packages/extension/test/unit/messages.test.ts` (the host-message union is type-only; add the webview-side reducer test below instead)
- Test: `packages/webview/test/flowUtils.test.ts` — not touched; the new webview behaviour is a two-line state restore verified manually (see Step 6)

**Interfaces:**
- Consumes: `reviewFlowEdit`, `syncFlowIntoLiveRuns`, `resetRunsForFlow` from Tasks 2–4.
- Produces: host message `{ type: 'flowSaveCancelled'; flow: Flow }`.

- [ ] **Step 1: Add the host message type**

In `packages/extension/src/messages.ts`, add to the `HostMessage` union next to `{ type: 'flowGenerated'; ... }`:

```ts
  | { type: 'flowSaveCancelled'; flow: Flow }
```

- [ ] **Step 2: Rewrite the saveFlow handler**

Replace `packages/extension/src/webviewPanel.ts:121-129` with:

```ts
      case 'saveFlow': {
        // A live run of this flow may already have consumed the part being edited; decide before
        // anything is written, so a declined prompt leaves the file untouched.
        const decision = await this._runner.reviewFlowEdit(message.flow);
        if (decision === 'cancelled') {
          // Hand the draft back — the webview clears its builder as soon as it posts.
          this.postMessage({ type: 'flowSaveCancelled', flow: message.flow });
          return;
        }
        const isGlobal = typeof message.isGlobal === 'boolean'
          ? message.isGlobal
          : this.configManager.isGlobalSourcePath(message.flow.sourcePath);
        await this.configManager.saveFlow(message.flow, isGlobal);
        if (decision === 'reset') await this._runner.resetRunsForFlow(message.flow);
        else await this._runner.syncFlowIntoLiveRuns(message.flow);
        await this._sendAllData();
        vscode.window.showInformationMessage(`Flow '${message.flow.name}' saved.`);
        return;
      }
```

`this.postMessage(...)` is the panel's existing helper (see `webviewPanel.ts:233`); `FlowStep` and `Flow` are already imported there via the message types.

- [ ] **Step 3: Handle the cancellation in the webview**

In `packages/webview/src/hooks/useAppLogic.ts`, add a case inside `handleHostMessage`'s switch (next to `case 'flowGenerated'`):

```ts
      case 'flowSaveCancelled':
        // The host refused the save (a live run would have to be reset). Reopen the builder with
        // the user's draft so the edit is not lost.
        buildState.setEditingFlow(message.flow);
        buildState.setBuilderError('Not saved — a live run of this flow would have to be reset.');
        break;
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — core, extension-unit and webview suites all green.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/webviewPanel.ts packages/extension/src/messages.ts packages/webview/src/hooks/useAppLogic.ts
git commit -m "feat: gate mid-run workflow saves on a reset confirmation"
```

- [ ] **Step 6: Manual verification in the extension host**

Press F5 (or run the `Run Extension` launch config), then in the ClaudeSteps cockpit:

1. Start a run of a flow with at least three chained steps; let step 1 finish and leave step 2 running.
2. Edit the flow to append a step 4 and save → expect no prompt, the toast `Flow '…' saved.`, and step 4 appearing in the running board as locked.
3. Edit step 1's agent and save → expect the modal listing the run and `step-1 (modified)`. Press Cancel → expect no toast, the builder still open with the edit intact, and the run untouched.
4. Repeat the same edit and press **Reset & Save** → expect the run to restart empty, its artifacts gone from the run output directory, and the runs table row to follow the new runId.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Classification rules (DAG, progressed, added/removed/modified) | Task 1 |
| Flow-level rules (`name`, `inputs`, `trustLevel`, description safe) | Task 1 |
| Safe path table (flow, steps, locks, bookkeeping, run file, audit, review reports, broadcast, runIf) | Task 2 |
| Blocking path — modal contents and buttons | Task 4 |
| Blocking path — reset per live run | Task 3 |
| `resetRun` `extraStepIds` for removed steps' artifacts | Task 3 (implemented as `extraSteps: FlowStep[]`, richer than the spec's ids because `_producedFilePaths` needs the step's `produces`) |
| Cancel does not write the file, `flowSaveCancelled` restores the draft | Task 5 |
| Closed runs untouched | Task 2 (`_liveRunsOfFlow` filter), tested in Task 3 |

**Type consistency:** `assessFlowEdit(oldFlow, newFlow, runState)` is called in Task 4 exactly as defined in Task 1. `_liveRunsOfFlow` is defined in Task 2 and consumed in Tasks 3 and 4. `resetRun`'s new optional parameter is `opts: { extraSteps?: FlowStep[] }` in both its definition (Task 3b) and its call site (Task 3c). `reviewFlowEdit`'s three return values match the three branches of the Task 5 handler.

**Known deviation from the spec:** the spec named the reset parameter `extraStepIds`; the plan uses `extraSteps: FlowStep[]` because `_producedFilePaths` resolves `step.produces`, which bare ids cannot supply.
