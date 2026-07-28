import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
  const terminals = {
    onDidCloseRunningStep: (cb: (r: string, s: string) => void) => { cbs.close = cb; },
    onDidEndRunningStep: (cb: (r: string, s: string) => void) => { cbs.end = cb; },
    onCheckStepReady: (cb: (r: string, s: string) => boolean | undefined) => { cbs.ready = cb; },
    runInTerminal: async () => {},
    cancelStep: () => true,
    dispose: () => {},
  } as unknown as TerminalManager;
  return { terminals, cbs };
}

function fakeStateManager() {
  const saved: FlowRunState[] = [];
  const manager = {
    saveRun: async (run: FlowRunState) => { saved.push(structuredClone(run)); },
    appendAuditLog: async () => {},
    clearAuditLog: async () => {},
    loadAuditLog: async () => [],
    loadLatestRun: async () => undefined,
    saveReport: async () => '',
    saveReviewReport: async () => '',
    deleteRunFile: async () => {},
    deleteReportFile: async () => {},
    deleteReviewReports: async () => {},
  } as unknown as StateManager;
  return { manager, saved };
}

function fakeConfig(projectPath: string) {
  return {
    getProjectPath: () => projectPath,
    loadAgents: async () => [],
    loadSkills: async () => [],
    loadFlows: async () => [],
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

function build() {
  const { terminals, cbs } = fakeTerminals();
  const state = fakeStateManager();
  posted = [];
  const orch = new RunOrchestrator(
    fakeConfig(projectPath),
    state.manager,
    terminals,
    (message: HostMessage) => { posted.push(message); }
  );
  return { orch, cbs, saved: state.saved };
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

