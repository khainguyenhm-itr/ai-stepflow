import { Flow, FlowRunState } from './types.js';
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
    const readyIds = pickAutoAdvanceSteps(this.flow.steps, done, this._startedStepIds);
    
    const actions: OrchestratorAction[] = [];
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
