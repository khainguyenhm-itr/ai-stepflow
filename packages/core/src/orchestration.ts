import { Flow, FlowRunState, FlowStep } from './types.js';
import * as machine from './runStateMachine.js';
import { pickAutoAdvanceSteps, pickRunIfCandidates, seedStartedSteps } from './runUtils.js';

/**
 * An action the host (Extension or CLI) should perform to advance the flow.
 */
export type OrchestratorAction =
  | { type: 'launch_headless'; stepId: string }
  | { type: 'launch_interactive'; stepId: string }
  | { type: 'park_interactive'; stepId: string }
  | { type: 'skip'; stepId: string };

/** Whether a step's `runIf` gate matches this run's inputs (no gate → always true). */
export function stepRunIfSatisfied(step: FlowStep, inputs: Record<string, string> = {}): boolean {
  const cond = step.runIf;
  if (!cond) return true;
  const raw = inputs[cond.input];
  if (cond.equals !== undefined) return raw === cond.equals;
  if (cond.min === undefined && cond.max === undefined) return true;
  if (!raw || !raw.trim()) return false; // unset/blank — Number('') is 0, not NaN, so check this first
  const num = Number(raw);
  if (Number.isNaN(num)) return false; // can't evaluate numerically — fail closed, step gets skipped
  if (cond.min !== undefined && num < cond.min) return false;
  if (cond.max !== undefined && num > cond.max) return false;
  return true;
}

/**
 * Pure orchestration logic that decides which steps to run next.
 * It does not perform any side effects (like spawning processes or showing UI).
 */
export class FlowOrchestrator {
  private _startedStepIds: Set<string>;

  constructor(
    public readonly flow: Flow,
    public readonly runState: FlowRunState
  ) {
    this._startedStepIds = seedStartedSteps(runState.steps);
  }

  /**
   * Identifies steps ready to run according to the DAG. All steps run interactively
   * (one at a time) to avoid terminal clutter; the rest are parked.
   */
  getAutoAdvanceActions(): OrchestratorAction[] {
    const done = machine.doneStepIds(this.runState);
    const actions: OrchestratorAction[] = [];

    // runIf is evaluated over a superset of the normal ready set (roots included): skipping
    // opens no terminal and does no work, so it isn't subject to the "never self-start a run"
    // rule that keeps root steps out of ordinary auto-advance.
    const skipCandidateIds = pickRunIfCandidates(this.flow.steps, done, this._startedStepIds);
    for (const id of skipCandidateIds) {
      const step = this.flow.steps.find(s => s.id === id);
      if (step?.runIf && !stepRunIfSatisfied(step, this.runState.inputs)) {
        actions.push({ type: 'skip', stepId: id });
        this._startedStepIds.add(id);
      }
    }

    const readyIds = pickAutoAdvanceSteps(this.flow.steps, done, this._startedStepIds);
    let interactiveLaunched = false;

    for (const id of readyIds) {
      const step = this.flow.steps.find(s => s.id === id);
      if (!step) continue;

      // All steps run interactively. Only one launches at a time;
      // the rest are parked until a terminal slot frees up.
      if (!interactiveLaunched) {
        actions.push({ type: 'launch_interactive', stepId: id });
        this._startedStepIds.add(id);
        interactiveLaunched = true;
      } else {
        actions.push({ type: 'park_interactive', stepId: id });
      }
    }
    return actions;
  }

  /**
   * Returns the set of step IDs that have already been launched or moved past
   * their initial state.
   */
  getStartedStepIds(): Set<string> {
    return new Set(this._startedStepIds);
  }
}
