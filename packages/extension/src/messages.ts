import { Agent, AgentInput, Flow, FlowRunState, Skill, SkillInput, ReviewKit, ReviewKitInput, isFlowShape, isFlowRunStateShape, isAgentInputShape, isSkillInputShape } from '@ai-stepflow/core';

export interface HumanReview {
  decision: 'approved' | 'rejected';
  comment?: string;
  checklist?: Record<string, boolean>;
}

/** One timestamped transition in a run's audit trail (as stored/loaded by StateManager). */
export interface AuditEntry {
  timestamp: string;
  status: string;
  stepId: string;
  message?: string;
  runId?: string;
}

/** A historyEvent attached to an authoritative state broadcast. */
export interface HistoryEvent {
  timestamp: string;
  status: string;
  stepId: string;
  message?: string;
}

/** Every message the extension host is allowed to post back to the webview. */
export type HostMessage =
  | {
      type: 'loadData';
      flows: Flow[];
      agents: Agent[];
      skills: Skill[];
      reviewKits: ReviewKit[];
      connectedMcpServers: string[];
      auditLogs: Record<string, AuditEntry[]>;
      runSummaries: { flowId: string; runId: string; runName?: string; completedSteps: number; failedSteps?: number; totalSteps: number; mtimeMs: number; costUsd?: number; tokensUsed?: number; taskTimeMs?: number; reviewTimeMs?: number }[];
      globalPath: string;
      projectPath: string;
      uiPrefs: Record<string, string>;
      /** Whether the bundled default agents/skills library is installed (any scope). */
      defaultLibraryInstalled: boolean;
      /** Recently-opened workspaces (machine-global), most-recent first. */
      recentWorkspaces: { path: string; name: string; lastOpenedMs: number }[];
      /** Run metrics summed across all recent workspaces (current repo included), for the Overview "All" scope. */
      runTotalsAll: { runs: number; completed: number; inProgress: number; costUsd: number; tokensUsed: number; taskTimeMs: number; reviewTimeMs: number };
      /** Daily run activity (last 90 days) across all recent workspaces, for the Overview "All" trend chart and date-range filtering. */
      runTrendAll: { date: string; runs: number; completed: number; inProgress: number; costUsd: number; tokensUsed: number; taskTimeMs: number }[];
    }
  | { type: 'mcpServers'; connectedMcpServers: string[] }
  | { type: 'restoreRun'; flow: Flow; runState: FlowRunState; previousRunId?: string }
  | { type: 'stepUpdate'; stepId: string; output: string; append?: boolean }
  | { type: 'aiReviewUpdate'; stepId: string; output: string; append?: boolean }
  | { type: 'runStateChanged'; runState: FlowRunState; historyEvent?: HistoryEvent }
  | { type: 'resetAuditLog'; flowId: string; runId?: string; stepIds?: string[] }
  | { type: 'runDeleted'; flowId: string; runId: string }
  | { type: 'fileImported'; kind: 'agent'; item: { name: string; description: string; model: string; tools: string; systemPrompt: string } }
  | { type: 'fileImported'; kind: 'skill'; item: { name: string; description: string; instructions: string } }
  | { type: 'fileImported'; kind: 'review'; item: { name: string; description: string; content: string } }
  | { type: 'draftGenerated'; kind: 'agent' | 'skill'; name?: string; description?: string; content?: string; reply?: string; error?: string }
  | { type: 'flowGenerated'; flow?: Flow; reply?: string; error?: string }
  | { type: 'navigateToTab'; tab: 'flows' | 'agents' | 'skills' | 'reviews' | 'overview' }
  | { type: 'runClosed'; flowId?: string; runId?: string; finalized?: boolean };

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
  | { type: 'createReviewKit'; review: ReviewKitInput; isGlobal?: boolean }
  | { type: 'updateReviewKit'; review: ReviewKitInput; isGlobal?: boolean; originalSourcePath?: string }
  | { type: 'deleteFlow'; flow: Flow }
  | { type: 'deleteAgent'; agent: Agent }
  | { type: 'deleteSkill'; skill: Skill }
  | { type: 'deleteReviewKit'; review: ReviewKit }
  | { type: 'updateRunState'; runState: FlowRunState; historyEvent?: { timestamp: string; status: string; message?: string; stepId: string } }
  | { type: 'switchRun'; flowId: string; runId: string }
  | { type: 'runStep'; stepId: string; flow?: Flow; runState?: FlowRunState; description?: string; historyEvent?: { timestamp: string; status: string; message?: string } }
  | { type: 'cancelStep'; stepId: string }
  | { type: 'runAgent'; agent: Agent; description?: string }
  | { type: 'runSkill'; skill: Skill; description?: string }
  | { type: 'reviewStep'; stepId: string; decision: 'approved' | 'rejected' }
  | { type: 'setAutoReview'; enabled: boolean }
  | { type: 'resetRun' }
  | { type: 'resetStep'; stepId: string }
  | { type: 'closeRun', finalize?: boolean }
  | { type: 'deleteRun' }
  | { type: 'verifyRun' }
  | { type: 'exportRunReport' }
  | { type: 'importAgentFile' }
  | { type: 'importSkillFile' }
  | { type: 'importReviewFile' }
  | { type: 'installReviewDefault'; isGlobal?: boolean }
  | { type: 'generateDraft'; kind: 'agent' | 'skill'; prompt: string; history?: { role: 'user' | 'assistant'; content: string }[] }
  | { type: 'savePref'; key: string; value: string; global?: boolean }
  | { type: 'generateFlow'; description: string; flow?: Flow; history?: { role: 'user' | 'assistant'; content: string }[] }
  | { type: 'connectMcpServer'; config: { name: string; scope: 'global' | 'local'; command: string; args: string[]; env?: Record<string, string> } }
  | { type: 'runCommand'; command: RunnableCommand }
  | { type: 'openWorkspace'; path: string }
  | { type: 'revealPath'; path: string }
  | { type: 'installGitnexus' }
  | { type: 'alert'; text: string };

/** VS Code command ids the Overview quick-settings panel is allowed to trigger. Whitelisted to keep the webview from invoking arbitrary commands. */
export const RUNNABLE_COMMANDS = [
  'ai-stepflow.installDefaults',
  'ai-stepflow.refreshAll',
  'ai-stepflow.astGraph.rescan',
  'ai-stepflow.astGraph.reregisterMcp',
  'workbench.action.openSettings'
] as const;
export type RunnableCommand = (typeof RUNNABLE_COMMANDS)[number];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Looks like a flow object the handlers can safely touch (id/sourcePath drive file ops).
 * Delegates to the core Zod shape guard so the `steps` array is validated element-deep,
 * not just "is an array".
 */
const isFlowLike = (value: unknown): boolean => isFlowShape(value);

/** Deep guards: assert every field the save/update handlers read is present and well-typed. */
const isAgentLike = (value: unknown): boolean => isAgentInputShape(value);
const isSkillLike = (value: unknown): boolean => isSkillInputShape(value);

/** Per-type predicate; returns true only when the fields each handler reads are present and well-typed. */
const validators: Record<string, (m: Record<string, unknown>) => boolean> = {
  ready: () => true,
  importAgentFile: () => true,
  importSkillFile: () => true,
  importReviewFile: () => true,
  installReviewDefault: () => true,
  resetRun: () => true,
  resetStep: m => isString(m.stepId),
  closeRun: m => m.finalize === undefined || typeof m.finalize === 'boolean',
  deleteRun: () => true,
  verifyRun: () => true,
  exportRunReport: () => true,
  loadFlow: m => isFlowLike(m.flow) && (m.runState === undefined || isFlowRunStateShape(m.runState)),
  openFile: m => isString(m.path),
  saveFlow: m => isFlowLike(m.flow),
  createAgent: m => isAgentLike(m.agent),
  updateAgent: m => isAgentLike(m.agent),
  createSkill: m => isSkillLike(m.skill),
  updateSkill: m => isSkillLike(m.skill),
  createReviewKit: m => isObject(m.review) && isString((m.review as any).name),
  updateReviewKit: m => isObject(m.review) && isString((m.review as any).name),
  deleteFlow: m => isObject(m.flow) && isString(m.flow.sourcePath),
  deleteAgent: m => isObject(m.agent) && isString(m.agent.sourcePath),
  deleteSkill: m => isObject(m.skill) && isString(m.skill.sourcePath),
  deleteReviewKit: m => isObject(m.review) && isString((m.review as any).sourcePath),
  updateRunState: m => isFlowRunStateShape(m.runState),
  switchRun: m => isString(m.flowId) && isString(m.runId),
  runStep: m => isString(m.stepId)
    && (m.flow === undefined || isFlowLike(m.flow))
    && (m.runState === undefined || isFlowRunStateShape(m.runState)),
  cancelStep: m => isString(m.stepId),
  runAgent: m => isAgentLike(m.agent),
  runSkill: m => isSkillLike(m.skill),
  reviewStep: m =>
    isString(m.stepId) &&
    (m.decision === 'approved' || m.decision === 'rejected'),
  setAutoReview: m => typeof m.enabled === 'boolean',
  generateDraft: m => (m.kind === 'agent' || m.kind === 'skill') && isString(m.prompt),
  generateFlow: m => isString(m.description) && (m.flow === undefined || isFlowLike(m.flow)),
  connectMcpServer: m => isObject(m.config) && isString(m.config.name) && isString(m.config.command),
  runCommand: m => isString(m.command) && (RUNNABLE_COMMANDS as readonly string[]).includes(m.command),
  openWorkspace: m => isString(m.path),
  revealPath: m => isString(m.path),
  installGitnexus: () => true,
  savePref: m => isString(m.key) && isString(m.value),
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
