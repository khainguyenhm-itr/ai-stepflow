import { Flow, FlowStep } from '@claudesteps/core/types';

/**
 * Where a `saveFlow` post came from. The host can refuse the save (a live run of the flow would
 * have to be reset), and the refusal arrives long after the webview cleared its editing state — so
 * the origin is stashed when the message is posted and consulted when `flowSaveCancelled` lands.
 */
export type FlowSaveOrigin =
  /** The flow builder modal was open and the user pressed Save. */
  | { from: 'builder' }
  /** The step editor was open over the run board and the user saved just that step. */
  | { from: 'stepEditor'; step: { step: FlowStep; index: number }; stepIsNew: boolean }
  /** Posted straight from the run board (a step deleted inline) — no editor was open. */
  | { from: 'board' };

export const FLOW_SAVE_REFUSED = 'Not saved — a live run of this flow would have to be reset.';

/** The editing state to restore after a refused save. */
export interface FlowSaveCancelledState {
  editingFlow: Flow;
  editingStep: { step: FlowStep; index: number } | null;
  stepEditFromBoard: boolean;
  stepIsNew: boolean;
  builderError: string | null;
  stepError: string | null;
}

/**
 * What the webview should reopen when the host refuses a flow save, given where the save came from
 * and the draft the host handed back.
 *
 * Returns `null` when there is nothing to reopen: the save came from the run board with no editor
 * open, and popping a full flow builder the user never opened — pre-filled with a draft whose step
 * is already deleted — is worse than leaving the view alone (the host surfaces the refusal).
 */
export function flowSaveCancelledState(origin: FlowSaveOrigin | null, draft: Flow): FlowSaveCancelledState | null {
  if (!origin || origin.from === 'board') return null;
  const base = {
    editingFlow: draft,
    editingStep: null,
    stepEditFromBoard: false,
    stepIsNew: false,
    builderError: null,
    stepError: null,
  };
  if (origin.from === 'stepEditor') {
    return { ...base, editingStep: origin.step, stepEditFromBoard: true, stepIsNew: origin.stepIsNew, stepError: FLOW_SAVE_REFUSED };
  }
  return { ...base, builderError: FLOW_SAVE_REFUSED };
}
