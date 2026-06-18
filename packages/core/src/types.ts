export type StepExecutionStatus = "locked" | "ready" | "running" | "completed" | "failed" | "cancelled";

export type StepReviewStatus = "not_required" | "pending" | "ai_review_running" | "waiting_human" | "approved" | "rejected";

export type StepCompletionStatus = "not_ready" | "ready_to_mark_done" | "done";

export interface Agent {
  name: string;
  description: string;
  model: string;
  tools?: string[];
  systemPrompt: string;
  sourcePath: string;
  /** Optional custom runner module (relative to the project or absolute) overriding how this agent invokes Claude. */
  runnerPath?: string;
  /** Cap the number of agentic turns for headless runs; overrides the global setting when set. */
  maxTurns?: number;
  /** True when the agent file declares itself as built-in metadata. */
  builtIn?: boolean;
}

/** Fields the create/update forms send for an agent (a subset of Agent). */
export interface AgentInput {
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
}

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  sourcePath: string;
  /** True when the skill is a markdown file directly inside the skills directory. */
  builtIn?: boolean;
}

/** Fields the create/update forms send for a skill (a subset of Skill). */
export interface SkillInput {
  name: string;
  description?: string;
  instructions?: string;
}

export interface FlowStep {
  id: string;
  title: string;
  agent: string;
  /** Primary skill (kept for backward compatibility; equals skills[0]). */
  skill: string;
  /** All skills of the step, run in order. Falls back to [skill] when unset. */
  skills?: string[];
  dependsOn?: string[];
  /** Files the step is expected to create/update (relative to the project). Validated before the step can be marked done. */
  produces?: string[];
  /** Files that must already exist before the step can start or complete. */
  requires?: string[];
  /** Substrings that must appear in at least one produced file. Asserts the step did real work, not just touched a file. */
  producesContains?: string[];
  input?: {
    humanRequired?: boolean;
    prompt?: string;
  };
  review: {
    required: boolean;
    /** Who performs the review when required. Defaults to human. */
    type?: "human" | "ai";
    /** Optional validator module for deterministic auto-review. */
    validatorPath?: string;
    /** For AI reviews: run the deep LLM review (layer 2) after the validator. Defaults to true; set false for validator-only (cheapest). */
    deep?: boolean;
    /** Optional timeout for the validator runner. */
    validatorTimeoutMs?: number;
    /** Optional file the review is based on (relative to the project or absolute).
     *  Empty means the review covers the step output in the terminal. */
    filePath?: string;
    reviewers?: {
      type: "human" | "ai";
      agent?: string;
      skill?: string;
    }[];
    /** Legacy flag kept so old flow files still parse; it has no effect. */
    approvalRequired?: boolean;
    checklist?: string[];
  };
  completion: {
    requireMarkDone: boolean;
  };
}

export interface FlowAiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Flow {
  id: string;
  name: string;
  description: string;
  inputs: Record<string, {
    type: string;
    required: boolean;
    label: string;
  }>;
  steps: FlowStep[];
  sourcePath: string;
  /** Optional history of the AI conversation that generated this flow. */
  aiConversation?: FlowAiMessage[];
}

export interface StepRunState {
  executionStatus: StepExecutionStatus;
  reviewStatus: StepReviewStatus;
  completionStatus: StepCompletionStatus;
  /** How many times this step has started running. 1 on first run, bumped on every rerun. */
  revision?: number;
  history?: { timestamp: string; status: string; message?: string }[];
  output?: string;
  /** Error message if the step failed or was blocked by a gate. */
  error?: string;
  aiReviewOutput?: string;
  humanReview?: {
    decision: "approved" | "rejected";
    comment?: string;
    checklist?: Record<string, boolean>;
  };
  startedAt?: string;
  completedAt?: string;
  /** Usage stats of the last execution; unset until the runner reports them. */
  tokensUsed?: number;
  modelUsed?: string;
  /** Cost (USD) of the last execution, taken from the run's own `result` event. */
  costUsd?: number;
}

export interface FlowRunState {
  flowId: string;
  runId: string;
  runName?: string;
  source: string;
  projectPath: string;
  inputs: Record<string, string>;
  steps: Record<string, StepRunState>;
}
