import { Flow, FlowRunState, FlowStep } from './types.js';
import * as machine from './runStateMachine.js';
import { pickAutoAdvanceSteps, seedStartedSteps } from './runUtils.js';

/**
 * An action the host (Extension or CLI) should perform to advance the flow.
 */
export type OrchestratorAction = 
  | { type: 'launch_headless'; stepId: string }
  | { type: 'launch_interactive'; stepId: string }
  | { type: 'park_interactive'; stepId: string };

/**
 * True when a step runs headless (an AI review gates it), so it has no shared UI surface and
 * can run concurrently with other headless steps. A step with no review, or a human-only
 * review, is interactive. Single source of truth shared by {@link FlowOrchestrator}, the
 * extension's step runner, and the CLI.
 */
export function isHeadlessStep(step: FlowStep): boolean {
  if (!step.review?.required) return false;
  return step.review.type === 'ai' || !!step.review.reviewers?.some(r => r.type === 'ai');
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
   * Identifies steps ready to run according to the DAG. Headless steps can all run
   * concurrently; interactive steps are limited to one at a time to avoid terminal
   * clutter, with the rest parked.
   */
  getAutoAdvanceActions(): OrchestratorAction[] {
    const done = machine.doneStepIds(this.runState);
    const readyIds = pickAutoAdvanceSteps(this.flow.steps, done, this._startedStepIds);
    
    const actions: OrchestratorAction[] = [];
    let interactiveLaunched = false;

    // In a multi-step advance (fan-out), we want to be stable.
    for (const id of readyIds) {
      const step = this.flow.steps.find(s => s.id === id);
      if (!step) continue;

      if (this.isHeadlessStep(step)) {
        actions.push({ type: 'launch_headless', stepId: id });
        this._startedStepIds.add(id);
      } else {
        // Only one interactive step starts at a time.
        if (!interactiveLaunched) {
          actions.push({ type: 'launch_interactive', stepId: id });
          this._startedStepIds.add(id);
          interactiveLaunched = true;
        } else {
          actions.push({ type: 'park_interactive', stepId: id });
        }
      }
    }
    return actions;
  }

  /**
   * True when a step runs headless (AI review or no review), so it has no shared UI surface and
   * can run concurrently.
   */
  isHeadlessStep(step: FlowStep): boolean {
    return isHeadlessStep(step);
  }

  /**
   * Returns the set of step IDs that have already been launched or moved past
   * their initial state.
   */
  getStartedStepIds(): Set<string> {
    return new Set(this._startedStepIds);
  }
}
