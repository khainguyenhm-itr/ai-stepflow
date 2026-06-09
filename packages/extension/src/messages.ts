import { Agent, AgentInput, Flow, FlowRunState, Skill, SkillInput } from '@ai-stepflow/core';

export interface HumanReview {
  decision: 'approved' | 'rejected';
  comment?: string;
  checklist?: Record<string, boolean>;
}

/** Every message the webview is allowed to send to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'loadFlow'; flow: Flow; runState?: FlowRunState }
  | { type: 'openFile'; path: string }
  | { type: 'saveFlow'; flow: Flow; isGlobal?: boolean }
  | { type: 'createAgent'; agent: AgentInput; isGlobal?: boolean }
  | { type: 'updateAgent'; agent: AgentInput; isGlobal?: boolean; originalSourcePath?: string }
  | { type: 'createSkill'; skill: SkillInput; isGlobal?: boolean }
  | { type: 'updateSkill'; skill: SkillInput; isGlobal?: boolean; originalSourcePath?: string }
  | { type: 'deleteFlow'; flow: Flow }
  | { type: 'deleteAgent'; agent: Agent }
  | { type: 'deleteSkill'; skill: Skill }
  | { type: 'updateRunState'; runState: FlowRunState; historyEvent?: { timestamp: string; status: string; message?: string; stepId: string } }
  | { type: 'runStep'; stepId: string; flow?: Flow; runState?: FlowRunState; description?: string; historyEvent?: { timestamp: string; status: string; message?: string } }
  | { type: 'runAgent'; agent: Agent; description?: string }
  | { type: 'runSkill'; skill: Skill; description?: string }
  | { type: 'submitHumanReview'; stepId: string; review: HumanReview; historyEvent?: { timestamp: string; status: string; message?: string } }
  | { type: 'markStepDone'; stepId: string; historyEvent?: { timestamp: string; status: string; message?: string } }
  | { type: 'verifyRun' }
  | { type: 'exportRunReport' }
  | { type: 'importAgentFile' }
  | { type: 'importSkillFile' }
  | { type: 'generateDraft'; kind: 'agent' | 'skill'; name: string; description?: string }
  | { type: 'alert'; text: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isString = (value: unknown): value is string => typeof value === 'string';

/** Looks like a flow object the handlers can safely touch (id/sourcePath drive file ops). */
const isFlowLike = (value: unknown): boolean =>
  isObject(value) && isString(value.id) && isString(value.sourcePath) && Array.isArray(value.steps);

const isAgentLike = (value: unknown): boolean => isObject(value) && isString(value.name);
const isSkillLike = (value: unknown): boolean => isObject(value) && isString(value.name);

/** Per-type predicate; returns true only when the fields each handler reads are present and well-typed. */
const validators: Record<string, (m: Record<string, unknown>) => boolean> = {
  ready: () => true,
  importAgentFile: () => true,
  importSkillFile: () => true,
  verifyRun: () => true,
  exportRunReport: () => true,
  loadFlow: m => isFlowLike(m.flow),
  openFile: m => isString(m.path),
  saveFlow: m => isFlowLike(m.flow),
  createAgent: m => isAgentLike(m.agent),
  updateAgent: m => isAgentLike(m.agent),
  createSkill: m => isSkillLike(m.skill),
  updateSkill: m => isSkillLike(m.skill),
  deleteFlow: m => isObject(m.flow) && isString(m.flow.sourcePath),
  deleteAgent: m => isObject(m.agent) && isString(m.agent.sourcePath),
  deleteSkill: m => isObject(m.skill) && isString(m.skill.sourcePath),
  updateRunState: m => isObject(m.runState),
  runStep: m => isString(m.stepId),
  runAgent: m => isAgentLike(m.agent),
  runSkill: m => isSkillLike(m.skill),
  submitHumanReview: m =>
    isString(m.stepId) &&
    isObject(m.review) &&
    (m.review.decision === 'approved' || m.review.decision === 'rejected'),
  markStepDone: m => isString(m.stepId),
  generateDraft: m => (m.kind === 'agent' || m.kind === 'skill') && isString(m.name),
  alert: m => isString(m.text)
};

/**
 * Validate a raw message received from the webview. Returns the message typed as
 * a {@link WebviewMessage} when it matches a known shape, otherwise null.
 */
export function validateMessage(raw: unknown): WebviewMessage | null {
  if (!isObject(raw) || !isString(raw.type)) return null;
  const validate = validators[raw.type];
  if (!validate || !validate(raw)) return null;
  return raw as unknown as WebviewMessage;
}
