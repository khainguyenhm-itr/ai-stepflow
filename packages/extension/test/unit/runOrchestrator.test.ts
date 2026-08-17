import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunOrchestrator } from '../../src/runOrchestrator.js';
import type { ConfigManager } from '../../src/configManager.js';
import type { StateManager } from '../../src/stateManager.js';
import type { TerminalManager } from '../../src/terminalManager.js';
import type { HostMessage } from '../../src/messages.js';
import * as machine from '@claudesteps/core';
import type { Flow, FlowRunState } from '@claudesteps/core';
import { recorder } from './vscodeStub.js';

/**
 * RunOrchestrator's defining guarantee is run isolation: several runs can hold live interactive
 * terminals at once, and an event from one must never touch another's state or leak into another's
 * webview messages. These tests drive that guarantee directly, plus the artifact-quiescence probe
 * the terminal fallback depends on.
 *
 * The collaborators are captured stubs rather than the real classes: the orchestrator only calls a
 * handful of methods on each, and the point here is the orchestrator's own logic.
 */

/** Captures the three callbacks the orchestrator registers, so tests can fire terminal events. */
function fakeTerminals() {
  const cbs: {
    close?: (runId: string, stepId: string) => void;
    end?: (runId: string, stepId: string) => void;
    ready?: (runId: string, stepId: string) => boolean | undefined;
  } = {};
  // Every interactive launch, so a test can assert a step was (or was NOT) started.
  const launches: { prompt: string; stepId?: string; runId?: string }[] = [];
  const terminals = {
    onDidCloseRunningStep: (cb: (r: string, s: string) => void) => { cbs.close = cb; },
    onDidEndRunningStep: (cb: (r: string, s: string) => void) => { cbs.end = cb; },
    onCheckStepReady: (cb: (r: string, s: string) => boolean | undefined) => { cbs.ready = cb; },
    runInTerminal: async (
      prompt: string, _projectPath: string, _agent?: unknown, _submit?: boolean,
      stepId?: string, _sessionId?: string, runId?: string
    ) => { launches.push({ prompt, stepId, runId }); },
    cancelStep: () => true,
    dispose: () => {},
  } as unknown as TerminalManager;
  return { terminals, cbs, launches };
}

function fakeStateManager(latestRun?: FlowRunState) {
  const saved: FlowRunState[] = [];
  const manager = {
    saveRun: async (run: FlowRunState) => { saved.push(structuredClone(run)); },
    appendAuditLog: async () => {},
    clearAuditLog: async () => {},
    loadAuditLog: async () => [],
    loadLatestRun: async () => latestRun,
    saveReport: async () => '',
    saveReviewReport: async () => '',
    deleteRunFile: async () => {},
    deleteReportFile: async () => {},
    deleteReviewReports: async () => {},
  } as unknown as StateManager;
  return { manager, saved };
}

function fakeConfig(projectPath: string, flows: Flow[] = [], agents: { name: string }[] = []) {
  return {
    getProjectPath: () => projectPath,
    loadAgents: async () => agents,
    loadSkills: async () => [],
    loadFlows: async () => flows,
    loadUiPrefs: async () => ({}),
  } as unknown as ConfigManager;
}

function makeFlow(id: string, produces?: string[]): Flow {
  return {
    id,
    name: id,
    description: '',
    inputs: {},
    steps: [{ id: 'step-1', title: 'Step 1', agent: 'po', skill: 'prd', produces, review: { required: true, type: 'human' } }],
    sourcePath: `/repo/.claudesteps/flows/${id}.yaml`,
  } as Flow;
}

function makeRun(flow: Flow, runId: string, projectPath: string): FlowRunState {
  return machine.initRunState(flow, { runId, projectPath, inputs: {} });
}

let projectPath: string;
let posted: HostMessage[];

function build(opts: { latestRun?: FlowRunState; flows?: Flow[]; agents?: { name: string }[] } = {}) {
  const { terminals, cbs, launches } = fakeTerminals();
  const state = fakeStateManager(opts.latestRun);
  posted = [];
  const orch = new RunOrchestrator(
    fakeConfig(projectPath, opts.flows, opts.agents),
    state.manager,
    terminals,
    (message: HostMessage) => { posted.push(message); }
  );
  return { orch, cbs, saved: state.saved, launches };
}

beforeEach(() => {
  recorder.reset();
  projectPath = mkdtempSync(path.join(os.tmpdir(), 'claudesteps-orch-'));
  recorder.workspaceFolders = [{ uri: { fsPath: projectPath } }];
});

afterEach(() => rmSync(projectPath, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Run registry and focus
// ---------------------------------------------------------------------------

test('the focused run backs currentFlow and runState', () => {
  const { orch } = build();
  const flow = makeFlow('f1');
  const run = makeRun(flow, 'run-1', projectPath);

  const beforeLoad = orch.currentFlow;
  assert.equal(beforeLoad, undefined);
  orch.setFlowAndRunState(flow, run);
  assert.equal(orch.currentFlow?.id, 'f1');
  assert.equal(orch.runState?.runId, 'run-1');
});

test('selecting a flow with no run keeps the flow but clears the focused run', () => {
  const { orch } = build();
  const flow = makeFlow('f1');
  orch.setFlowAndRunState(flow, makeRun(flow, 'run-1', projectPath));
  orch.setFlowAndRunState(flow, undefined);

  assert.equal(orch.currentFlow?.id, 'f1');
  assert.equal(orch.runState, undefined);
});

test('switching focus between two open runs does not disturb either run state', () => {
  const { orch } = build();
  const flow = makeFlow('f1');
  const runA = makeRun(flow, 'run-A', projectPath);
  const runB = makeRun(flow, 'run-B', projectPath);

  orch.setFlowAndRunState(flow, runA);
  orch.setFlowAndRunState(flow, runB);
  assert.equal(orch.runState?.runId, 'run-B');

  orch.setFlowAndRunState(flow, runA);
  assert.equal(orch.runState?.runId, 'run-A');
});

// ---------------------------------------------------------------------------
// Run isolation — the guarantee the per-run contexts exist for.
// ---------------------------------------------------------------------------

test('a terminal closing cancels only its own run, leaving the other run untouched', async () => {
  const { orch, cbs } = build();
  const flow = makeFlow('f1');
  const runA = makeRun(flow, 'run-A', projectPath);
  const runB = makeRun(flow, 'run-B', projectPath);
  orch.setFlowAndRunState(flow, machine.markRunning(runA, flow, 'step-1'));
  orch.setFlowAndRunState(flow, machine.markRunning(runB, flow, 'step-1'));

  await cbs.close!('run-A', 'step-1');

  // Focus is still run-B; with a singleton run state this event would have cancelled it.
  assert.equal(orch.runState?.runId, 'run-B');
  assert.equal(orch.runState?.steps['step-1'].executionStatus, 'running', "run-B was cancelled by run-A's event");
});

test('a step message caused by one run is tagged with that runId, so the webview cannot cross-route it', async () => {
  const { orch, cbs } = build();
  const flow = makeFlow('f1');
  const runA = makeRun(flow, 'run-A', projectPath);
  const runB = makeRun(flow, 'run-B', projectPath);
  orch.setFlowAndRunState(flow, machine.markRunning(runA, flow, 'step-1'));
  orch.setFlowAndRunState(flow, machine.markRunning(runB, flow, 'step-1')); // B is focused

  await cbs.close!('run-A', 'step-1');

  const stepUpdates = posted.filter((m): m is Extract<HostMessage, { type: 'stepUpdate' }> => m.type === 'stepUpdate');
  assert.equal(stepUpdates.length, 1);
  assert.equal(stepUpdates[0].runId, 'run-A', 'the message was attributed to the focused run instead of its own');
});

test('a terminal event for an unknown run is ignored rather than throwing', async () => {
  const { orch, cbs } = build();
  const flow = makeFlow('f1');
  orch.setFlowAndRunState(flow, makeRun(flow, 'run-A', projectPath));

  await cbs.close!('run-does-not-exist', 'step-1');
  await cbs.end!('run-does-not-exist', 'step-1');
  assert.equal(posted.filter(m => m.type === 'stepUpdate').length, 0);
});

test('closing a terminal for a step that is not running changes nothing', async () => {
  const { orch, cbs } = build();
  const flow = makeFlow('f1');
  orch.setFlowAndRunState(flow, makeRun(flow, 'run-A', projectPath)); // step is idle, not running

  await cbs.close!('run-A', 'step-1');
  assert.equal(posted.filter(m => m.type === 'stepUpdate').length, 0);
});

// ---------------------------------------------------------------------------
// Artifact-quiescence probe used by the no-shell-integration fallback.
// ---------------------------------------------------------------------------

test('the readiness probe reports "nothing to gate on" for a step declaring no artifacts', () => {
  const { orch, cbs } = build();
  const flow = makeFlow('f1'); // no produces, no review.filePath
  orch.setFlowAndRunState(flow, makeRun(flow, 'run-A', projectPath));

  assert.equal(cbs.ready!('run-A', 'step-1'), undefined);
});

test('the readiness probe returns undefined for an unknown run or step', () => {
  const { orch, cbs } = build();
  const flow = makeFlow('f1', ['docs/plan.md']);
  orch.setFlowAndRunState(flow, makeRun(flow, 'run-A', projectPath));

  assert.equal(cbs.ready!('run-nope', 'step-1'), undefined);
  assert.equal(cbs.ready!('run-A', 'step-nope'), undefined);
});

test('the readiness probe keeps waiting while a declared artifact is missing', () => {
  const { orch, cbs } = build();
  const flow = makeFlow('f1', ['docs/plan.md']);
  orch.setFlowAndRunState(flow, machine.markRunning(makeRun(flow, 'run-A', projectPath), flow, 'step-1'));

  assert.equal(cbs.ready!('run-A', 'step-1'), false);
});

test('a freshly written artifact is not ready on first sight — it must hold steady first', () => {
  const { orch, cbs } = build();
  const flow = makeFlow('f1', ['docs/plan.md']);
  orch.setFlowAndRunState(flow, machine.markRunning(makeRun(flow, 'run-A', projectPath), flow, 'step-1'));

  const artifact = path.join(projectPath, 'docs', 'plan.md');
  mkdirSync(path.dirname(artifact), { recursive: true });
  writeFileSync(artifact, 'draft', 'utf8');

  // First observation only records the signature; a step that is still being written must not be
  // declared finished just because the file exists.
  assert.equal(cbs.ready!('run-A', 'step-1'), false);
  // Still inside the quiet window on the next poll.
  assert.equal(cbs.ready!('run-A', 'step-1'), false);
});

test('a changing artifact resets the quiet window instead of counting toward it', () => {
  const { orch, cbs } = build();
  const flow = makeFlow('f1', ['docs/plan.md']);
  orch.setFlowAndRunState(flow, machine.markRunning(makeRun(flow, 'run-A', projectPath), flow, 'step-1'));

  const artifact = path.join(projectPath, 'docs', 'plan.md');
  mkdirSync(path.dirname(artifact), { recursive: true });
  writeFileSync(artifact, 'draft', 'utf8');
  assert.equal(cbs.ready!('run-A', 'step-1'), false);

  writeFileSync(artifact, 'draft plus much more content', 'utf8');
  assert.equal(cbs.ready!('run-A', 'step-1'), false, 'a still-growing artifact was treated as quiescent');
});

test('a root step whose runIf does not match is auto-skipped on run creation, unlocking its dependent', async () => {
  const { orch } = build();
  const flow: Flow = {
    id: 'f1', name: 'f1', description: '', sourcePath: '/repo/.claudesteps/flows/f1.yaml',
    inputs: { level: { type: 'string', required: true, label: 'Level' } },
    steps: [
      { id: 'a', title: 'Hard step', agent: 'po', skill: 'prd', review: { required: true, type: 'human' }, runIf: { input: 'level', equals: '2' } },
      { id: 'b', title: 'Step B', agent: 'po', skill: 'prd', review: { required: true, type: 'human' }, dependsOn: ['a'] },
    ],
  } as Flow;
  const run = machine.initRunState(flow, { runId: 'run-1', projectPath, inputs: { level: '1' } });

  orch.setFlowAndRunState(flow, undefined); // focus the flow so adoptRunState can resolve it by id
  await orch.adoptRunState(run);

  assert.equal(orch.runState?.steps.a.executionStatus, 'skipped');
  assert.equal(orch.runState?.steps.a.completionStatus, 'done');
  assert.equal(orch.runState?.steps.b.executionStatus, 'ready');
});

// ---------------------------------------------------------------------------
// Reopening the cockpit must not start work.
//
// `restore()` runs on the webview's 'ready' message — every panel open and window reload — and
// targets loadLatestRun(), which is not necessarily the run the user is looking at. Launching a
// step there fires work the user never asked for AND claims the step's `${runId}::${stepId}`
// terminal, so the user's own "Run Step" click can no longer open a clean session.
// ---------------------------------------------------------------------------

/** Two AI-reviewed steps, `b` depending on `a` — `b` auto-launches the moment `a` is done. */
function makeAiReviewChainFlow(): Flow {
  return {
    id: 'f1', name: 'f1', description: '', sourcePath: '/repo/.claudesteps/flows/f1.yaml',
    inputs: {},
    steps: [
      { id: 'a', title: 'Step A', agent: 'po', skill: 'prd', review: { required: true, type: 'ai' } },
      { id: 'b', title: 'Step B', agent: 'po', skill: 'prd', review: { required: true, type: 'ai' }, dependsOn: ['a'] },
    ],
  } as Flow;
}

test('restore does not launch the next ready step — reopening the panel must start no work', async () => {
  const flow = makeAiReviewChainFlow();
  let run = machine.initRunState(flow, { runId: 'run-1', projectPath, inputs: {} });
  run = machine.applyAiReview(machine.markCompleted(machine.markRunning(run, flow, 'a'), flow, 'a'), flow, 'a', 'approved');
  const { orch, launches } = build({ latestRun: run, flows: [flow], agents: [{ name: 'po' }] });

  await orch.restore();
  // Let any `void`-ed launch promise settle before asserting.
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(launches, [], 'reopening the panel launched a step');
  assert.equal(orch.runState?.steps.b.executionStatus, 'ready');
});

test('adoptRunState does not launch a step when a run is created', async () => {
  const flow = makeAiReviewChainFlow();
  let run = machine.initRunState(flow, { runId: 'run-1', projectPath, inputs: {} });
  run = machine.applyAiReview(machine.markCompleted(machine.markRunning(run, flow, 'a'), flow, 'a'), flow, 'a', 'approved');
  const { orch, launches } = build({ flows: [flow], agents: [{ name: 'po' }] });

  await orch.adoptRunState(run);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(launches, [], 'adopting a run launched a step');
});

test('a runIf skip still cascades on reopen without launching the step it unlocked', async () => {
  const flow: Flow = {
    id: 'f1', name: 'f1', description: '', sourcePath: '/repo/.claudesteps/flows/f1.yaml',
    inputs: { level: { type: 'string', required: true, label: 'Level' } },
    steps: [
      { id: 'a', title: 'Gated', agent: 'po', skill: 'prd', review: { required: true, type: 'ai' }, runIf: { input: 'level', equals: '2' } },
      { id: 'b', title: 'Step B', agent: 'po', skill: 'prd', review: { required: true, type: 'ai' }, dependsOn: ['a'] },
    ],
  } as Flow;
  const run = machine.initRunState(flow, { runId: 'run-1', projectPath, inputs: { level: '1' } });
  const { orch, launches } = build({ latestRun: run, flows: [flow], agents: [{ name: 'po' }] });

  await orch.restore();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(orch.runState?.steps.a.executionStatus, 'skipped', 'runIf gate was not resolved on reopen');
  assert.equal(orch.runState?.steps.b.executionStatus, 'ready', 'the skip did not unlock its dependent');
  assert.deepEqual(launches, [], 'the unlocked dependent was launched');
});

test('editRunMeta refuses to save when a required flow input is left blank', async () => {
  const { orch, saved } = build();
  const flow: Flow = {
    id: 'f1', name: 'f1', description: '', sourcePath: '/repo/.claudesteps/flows/f1.yaml',
    inputs: { level: { type: 'string', required: true, label: 'Level' } },
    steps: [{ id: 'step-1', title: 'Step 1', agent: 'po', skill: 'prd', review: { required: true, type: 'human' } }],
  } as Flow;
  const run = makeRun(flow, 'run-1', projectPath);
  orch.setFlowAndRunState(flow, run);

  await orch.editRunMeta('my-run', {});
  assert.equal(orch.runState?.inputs.level, undefined, 'blank required input must not be persisted');
  assert.equal(saved.length, 0);

  await orch.editRunMeta('my-run', { level: '2' });
  assert.equal(orch.runState?.inputs.level, '2');
});

test('two runs of the same step id keep separate readiness snapshots', () => {
  const { orch, cbs } = build();
  const flow = makeFlow('f1', ['docs/plan.md']);
  orch.setFlowAndRunState(flow, machine.markRunning(makeRun(flow, 'run-A', projectPath), flow, 'step-1'));
  orch.setFlowAndRunState(flow, machine.markRunning(makeRun(flow, 'run-B', projectPath), flow, 'step-1'));

  const artifact = path.join(projectPath, 'docs', 'plan.md');
  mkdirSync(path.dirname(artifact), { recursive: true });
  writeFileSync(artifact, 'draft', 'utf8');

  // Both runs share a stepId; neither may inherit the other's snapshot.
  assert.equal(cbs.ready!('run-A', 'step-1'), false);
  assert.equal(cbs.ready!('run-B', 'step-1'), false);
});

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
  // Plain filename `produces` entries resolve under the per-run output folder (see
  // `resolveFlowPath`), same convention as the `docs/plan.md` fixtures above — so the fixture is
  // written there, not at the project root.
  const doomed = path.join(projectPath, 'docs', 'doomed.md');
  const flow = makeChainFlow('f1', ['a', 'b']);
  flow.steps[1] = { ...flow.steps[1], produces: ['docs/doomed.md'] };
  mkdirSync(path.dirname(doomed), { recursive: true });
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

