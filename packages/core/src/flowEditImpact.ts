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
