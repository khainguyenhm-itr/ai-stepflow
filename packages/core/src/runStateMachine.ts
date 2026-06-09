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
export function initRunState(flow: Flow, opts: { runId: string; projectPath?: string; inputs?: Record<string, string> }): FlowRunState {
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

export function markRunning(state: FlowRunState, flow: Flow, stepId: string): FlowRunState {
  const step = flow.steps.find(s => s.id === stepId);
  const revision = (state.steps[stepId]?.revision ?? 0) + 1;
  const patch: Partial<StepRunState> = { executionStatus: 'running', output: '', startedAt: new Date().toISOString(), revision };
  if (step?.review.required) {
    patch.reviewStatus = 'pending';
    patch.aiReviewOutput = '';
  }
  return patchStep(state, flow, stepId, patch, { status: 'running', message: revision > 1 ? `rerun #${revision}` : undefined });
}

/** A finished run: "completed" is also "done" when the step has no review gate. */
export function markCompleted(state: FlowRunState, flow: Flow, stepId: string, metrics: StepMetrics = {}): FlowRunState {
  const step = flow.steps.find(s => s.id === stepId);
  const patch: Partial<StepRunState> = { executionStatus: 'completed', completedAt: new Date().toISOString(), ...metrics };
  if (!step?.review.required) patch.completionStatus = 'done';
  return patchStep(state, flow, stepId, patch, { status: 'completed' });
}

export function markFailed(state: FlowRunState, flow: Flow, stepId: string, metrics: StepMetrics = {}): FlowRunState {
  return patchStep(state, flow, stepId, { executionStatus: 'failed', ...metrics }, { status: 'failed' });
}

/** A run the user cancelled mid-flight: terminal for this attempt, but the step can be re-run. */
export function markCancelled(state: FlowRunState, flow: Flow, stepId: string, metrics: StepMetrics = {}): FlowRunState {
  return patchStep(state, flow, stepId, { executionStatus: 'cancelled', ...metrics }, { status: 'cancelled' });
}

export function applyAiReview(state: FlowRunState, flow: Flow, stepId: string, status: 'ai_review_running' | 'approved' | 'rejected' | 'waiting_human', aiReviewOutput?: string): FlowRunState {
  const patch: Partial<StepRunState> = { reviewStatus: status };
  if (aiReviewOutput !== undefined) patch.aiReviewOutput = aiReviewOutput;
  if (status === 'approved') patch.completionStatus = 'done';
  else if (status === 'rejected') { patch.completionStatus = 'not_ready'; patch.executionStatus = 'ready'; }
  // The transient "running" state is not worth an audit entry; the verdicts are.
  const event = status === 'ai_review_running' ? undefined : { status: `ai-review ${status}` };
  return patchStep(state, flow, stepId, patch, event);
}

export function applyHumanReview(state: FlowRunState, flow: Flow, stepId: string, review: { decision: 'approved' | 'rejected'; comment?: string; checklist?: Record<string, boolean> }): FlowRunState {
  const approved = review.decision === 'approved';
  return patchStep(state, flow, stepId, {
    humanReview: review,
    reviewStatus: approved ? 'approved' : 'rejected',
    completionStatus: approved ? 'ready_to_mark_done' : 'not_ready',
    ...(approved ? {} : { executionStatus: 'ready' as const })
  }, { status: `human-review ${review.decision}`, message: review.comment });
}

export function markDone(state: FlowRunState, flow: Flow, stepId: string): FlowRunState {
  return patchStep(state, flow, stepId, { completionStatus: 'done' }, { status: 'done' });
}

/** Ids of steps already done, from the authoritative run state. */
export function doneStepIds(state: FlowRunState): Set<string> {
  const done = new Set<string>();
  for (const [id, s] of Object.entries(state.steps)) {
    if (s.completionStatus === 'done') done.add(id);
  }
  return done;
}
