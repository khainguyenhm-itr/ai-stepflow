import { Flow, FlowRunState, StepRunState } from './types.js';

/**
 * The run state machine, owned by the extension host. Every transition is a pure
 * function that takes the current {@link FlowRunState} and returns a new one — no
 * `vscode` import, so it can be unit-tested and is the single source of truth the
 * webview merely renders.
 */

export interface StepMetrics {
  modelUsed?: string;
  tokensUsed?: number;
  costUsd?: number;
  /** The run's captured output, folded into the step so a state broadcast stays self-consistent. */
  output?: string;
  /** High-level error description. */
  error?: string;
}

/** Lock steps whose dependencies are not all done; unlock them once they are. */
export function applyDependencyLocks(flow: Flow, steps: Record<string, StepRunState>): Record<string, StepRunState> {
  const next: Record<string, StepRunState> = { ...steps };
  for (const step of flow.steps) {
    const state = next[step.id];
    if (!state) continue;
    const depsDone = (step.dependsOn ?? []).every(id => next[id]?.completionStatus === 'done');
    if (depsDone && state.executionStatus === 'locked') {
      next[step.id] = { ...state, executionStatus: 'ready' };
    } else if (!depsDone && state.executionStatus === 'ready') {
      next[step.id] = { ...state, executionStatus: 'locked' };
    }
  }
  return next;
}

/** Build the initial run state for a flow: every step ready, review pending where required. */
export function initRunState(flow: Flow, opts: { runId: string; runName?: string; projectPath?: string; inputs?: Record<string, string> }): FlowRunState {
  const steps: Record<string, StepRunState> = {};
  for (const step of flow.steps) {
    steps[step.id] = {
      executionStatus: 'ready',
      reviewStatus: step.review.required ? 'pending' : 'not_required',
      completionStatus: 'not_ready',
      output: ''
    };
  }
  return {
    flowId: flow.id,
    runId: opts.runId,
    runName: opts.runName,
    source: flow.sourcePath,
    projectPath: opts.projectPath ?? '',
    inputs: opts.inputs ?? {},
    steps: applyDependencyLocks(flow, steps)
  };
}

/**
 * Replace one step's state and re-apply dependency locks across the run. When an
 * `event` is given it is appended (immutably) to the step's audit `history`, so every
 * meaningful transition leaves a timestamped trace the report and UI can render.
 */
function patchStep(
  state: FlowRunState,
  flow: Flow,
  stepId: string,
  patch: Partial<StepRunState>,
  event?: { status: string; message?: string }
): FlowRunState {
  const prev = state.steps[stepId];
  if (!prev) return state;
  const merged: StepRunState = { ...prev, ...patch };
  if (event) {
    const entry = { timestamp: new Date().toISOString(), status: event.status, ...(event.message ? { message: event.message } : {}) };
    merged.history = [...(prev.history ?? []), entry];
  }
  const steps = { ...state.steps, [stepId]: merged };
  return { ...state, steps: applyDependencyLocks(flow, steps) };
}

function dependentStepIds(flow: Flow, stepId: string): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const step of flow.steps) {
    for (const dep of step.dependsOn ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(step.id);
      dependents.set(dep, list);
    }
  }

  const result = new Set<string>();
  const queue = [...(dependents.get(stepId) ?? [])];
  for (const id of queue) {
    if (result.has(id)) continue;
    result.add(id);
    queue.push(...(dependents.get(id) ?? []));
  }
  return result;
}

/**
 * Re-running a done step invalidates everything downstream: their previous artifacts may
 * have been based on stale input. Keep the old output for reference, but clear completion
 * and review decisions so the DAG has to advance through those steps again.
 */
function invalidateForRerun(state: FlowRunState, flow: Flow, stepId: string): FlowRunState {
  const ids = new Set([stepId, ...dependentStepIds(flow, stepId)]);
  const steps: Record<string, StepRunState> = { ...state.steps };
  for (const id of ids) {
    const prev = steps[id];
    if (!prev) continue;
    const step = flow.steps.find(s => s.id === id);
    steps[id] = {
      ...prev,
      executionStatus: id === stepId ? prev.executionStatus : 'ready',
      reviewStatus: step?.review.required ? 'pending' : 'not_required',
      completionStatus: 'not_ready',
      error: undefined,
      aiReviewOutput: undefined,
      humanReview: undefined
    };
  }
  return { ...state, steps: applyDependencyLocks(flow, steps) };
}

export function markRunning(state: FlowRunState, flow: Flow, stepId: string): FlowRunState {
  const rerunDoneStep = state.steps[stepId]?.completionStatus === 'done';
  const baseState = rerunDoneStep ? invalidateForRerun(state, flow, stepId) : state;
  const step = flow.steps.find(s => s.id === stepId);
  const revision = (baseState.steps[stepId]?.revision ?? 0) + 1;
  const patch: Partial<StepRunState> = { executionStatus: 'running', completionStatus: 'not_ready', output: '', error: undefined, startedAt: new Date().toISOString(), revision };
  if (step?.review.required) {
    patch.reviewStatus = 'pending';
    patch.aiReviewOutput = '';
  }
  return patchStep(baseState, flow, stepId, patch, { status: 'running', message: revision > 1 ? `rerun #${revision}` : undefined });
}

/** A finished run: transitions from 'running' to 'completed'. 
 *  If no review is required, it can go straight to 'done'. 
 */
export function markCompleted(state: FlowRunState, flow: Flow, stepId: string, metrics: StepMetrics = {}): FlowRunState {
  const step = flow.steps.find(s => s.id === stepId);
  const patch: Partial<StepRunState> = { executionStatus: 'completed', completedAt: new Date().toISOString(), ...metrics };
  
  if (!step?.review.required) {
    // No review: go to 'done' unless the user explicitly wants to manually mark it.
    patch.completionStatus = step?.completion?.requireMarkDone ? 'ready_to_mark_done' : 'done';
  } else {
    // Review required: wait for decision.
    patch.completionStatus = 'not_ready';
    patch.reviewStatus = step.review.type === 'ai' ? 'ai_review_running' : 'waiting_human';
  }
  
  return patchStep(state, flow, stepId, patch, { status: 'completed' });
}

export function markFailed(state: FlowRunState, flow: Flow, stepId: string, metrics: StepMetrics = {}): FlowRunState {
  return patchStep(state, flow, stepId, { executionStatus: 'failed', ...metrics }, { status: 'failed' });
}

/** A run the user cancelled mid-flight: terminal for this attempt, but the step can be re-run. */
export function markCancelled(state: FlowRunState, flow: Flow, stepId: string, metrics: StepMetrics = {}): FlowRunState {
  return patchStep(state, flow, stepId, { executionStatus: 'cancelled', ...metrics }, { status: 'cancelled' });
}

export function applyAiReview(
  state: FlowRunState,
  flow: Flow,
  stepId: string,
  status: 'ai_review_running' | 'approved' | 'rejected' | 'waiting_human',
  aiReviewOutput?: string,
  reviewMetrics?: { tokensUsed?: number; costUsd?: number }
): FlowRunState {
  const step = flow.steps.find(s => s.id === stepId);
  const patch: Partial<StepRunState> = { reviewStatus: status };
  if (aiReviewOutput !== undefined) patch.aiReviewOutput = aiReviewOutput;

  if (reviewMetrics && state.steps[stepId]) {
    const prev = state.steps[stepId];
    if (reviewMetrics.tokensUsed != null) patch.tokensUsed = (prev.tokensUsed ?? 0) + reviewMetrics.tokensUsed;
    if (reviewMetrics.costUsd != null) patch.costUsd = (prev.costUsd ?? 0) + reviewMetrics.costUsd;
  }

  if (status === 'approved') {
    // AI Approved: go to 'done' unless manual confirmation is requested.
    patch.completionStatus = step?.completion?.requireMarkDone ? 'ready_to_mark_done' : 'done';
  } else if (status === 'rejected') {
    patch.completionStatus = 'not_ready';
    patch.executionStatus = 'ready';
  }

  const event = status === 'ai_review_running' ? undefined : { status: `ai-review ${status}` };
  return patchStep(state, flow, stepId, patch, event);
}

export function applyHumanReview(state: FlowRunState, flow: Flow, stepId: string, review: { decision: 'approved' | 'rejected'; comment?: string; checklist?: Record<string, boolean> }): FlowRunState {
  const step = flow.steps.find(s => s.id === stepId);
  const approved = review.decision === 'approved';
  
  const patch: Partial<StepRunState> = {
    humanReview: review,
    reviewStatus: approved ? 'approved' : 'rejected',
    completionStatus: approved ? (step?.completion?.requireMarkDone ? 'ready_to_mark_done' : 'done') : 'not_ready',
    ...(approved ? {} : { executionStatus: 'ready' as const })
  };
  
  return patchStep(state, flow, stepId, patch, { status: `human-review ${review.decision}`, message: review.comment });
}

export function markDone(state: FlowRunState, flow: Flow, stepId: string): FlowRunState {
  return patchStep(state, flow, stepId, { completionStatus: 'done' }, { status: 'done' });
}

/**
 * True when two step maps carry the same lock state. `applyDependencyLocks` only ever flips a
 * step's `executionStatus` between `locked` and `ready`, so comparing that field per step tells
 * us whether re-locking changed anything — a structural check that replaces a fragile,
 * key-order-dependent `JSON.stringify` comparison.
 */
export function lockStatesEqual(a: Record<string, StepRunState>, b: Record<string, StepRunState>): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const id of keysA) {
    const sb = b[id];
    if (!sb || a[id].executionStatus !== sb.executionStatus) return false;
  }
  return true;
}

/** Ids of steps already done, from the authoritative run state. */
export function doneStepIds(state: FlowRunState): Set<string> {
  const done = new Set<string>();
  for (const [id, s] of Object.entries(state.steps)) {
    if (s.completionStatus === 'done') done.add(id);
  }
  return done;
}
