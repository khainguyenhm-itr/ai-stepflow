export type StepExecutionStatus = "locked" | "ready" | "running" | "completed" | "failed" | "cancelled" | "skipped";

export type StepReviewStatus = "pending" | "ai_review_running" | "waiting_human" | "approved" | "rejected";

export type StepCompletionStatus = "not_ready" | "done";

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
  /** Grouping/filtering labels declared in frontmatter. */
  tags?: string[];
  /** True when the agent file declares itself as built-in metadata. */
  builtIn?: boolean;
  /** File modification time in ms since epoch. */
  modifiedAt?: number;
  /** History of the AI conversation that generated/refined this agent. */
  aiConversation?: FlowAiMessage[];
}

/** Fields the create/update forms send for an agent (a subset of Agent). */
export interface AgentInput {
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
  tags?: string[];
  aiConversation?: FlowAiMessage[];
}

export interface Skill {
  name: string;
  description: string;
  instructions: string;
  sourcePath: string;
  /** Grouping/filtering labels declared in frontmatter. */
  tags?: string[];
  /** True when the skill is a markdown file directly inside the skills directory. */
  builtIn?: boolean;
  /** File modification time in ms since epoch. */
  modifiedAt?: number;
  /** History of the AI conversation that generated/refined this skill. */
  aiConversation?: FlowAiMessage[];
}

/**
 * One recorded ad-hoc run of an agent or skill (launched from the library's Run button, not a flow
 * step). Persisted in the workspace's `.claudesteps/adhoc-runs.json` so the per-agent/skill history
 * survives extension reinstalls (like flow runs). Token/cost/model are NOT stored — they are read
 * lazily from the pinned session's `.jsonl` when the history is opened (see `readInteractiveSessionStats`).
 */
export interface AdhocRun {
  /** Unique id for this run record. */
  id: string;
  kind: 'agent' | 'skill';
  /** Agent or skill name this run was launched for. */
  name: string;
  /** Pinned `claude --session-id`, used both to read metrics and to `--resume` the session. */
  sessionId: string;
  /** Working directory the run was launched in (needed to locate the session file and to resume). */
  projectPath: string;
  /** The prompt/description supplied at launch, if any. */
  prompt?: string;
  /** ISO timestamp when the run was launched. */
  startedAt: string;
  /** Lazily enriched at list time — not persisted. */
  tokensUsed?: number;
  costUsd?: number;
  modelUsed?: string;
  /** Wall-clock span of the session in ms, derived from its `.jsonl` timestamps. */
  durationMs?: number;
}

/** Fields the create/update forms send for a skill (a subset of Skill). */
export interface SkillInput {
  name: string;
  description?: string;
  instructions?: string;
  tags?: string[];
  aiConversation?: FlowAiMessage[];
}

/** An LLM review-kit prompt used by the deep-review layer (see `review.ts` `loadReviewKit`). */
export interface ReviewKit {
  name: string;
  description: string;
  content: string;
  sourcePath: string;
  /** True when the review kit file declares itself as built-in metadata. */
  builtIn?: boolean;
  /** File modification time in ms since epoch. */
  modifiedAt?: number;
  /** History of the AI conversation that generated/refined this review kit. */
  aiConversation?: FlowAiMessage[];
}

/** Fields the create/update forms send for a review kit (a subset of ReviewKit). */
export interface ReviewKitInput {
  name: string;
  description?: string;
  content?: string;
  aiConversation?: FlowAiMessage[];
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
  /**
   * Optional gate: this step only runs when the named flow input matches. Unset → step always
   * runs (default, backward compatible). A step whose condition fails is auto-skipped — never
   * launched, never blocks its dependents — so one flow can serve several run "tiers" (e.g. a
   * `level` input selecting which steps apply) without splitting into separate flows.
   */
  runIf?: {
    /** Name of the flow input (a `Flow.inputs` key) to check. */
    input: string;
    /** Exact string match against the input's value. */
    equals?: string;
    /** Numeric lower bound (inclusive); the input's value is coerced with `Number(...)`. */
    min?: number;
    /** Numeric upper bound (inclusive); the input's value is coerced with `Number(...)`. */
    max?: number;
  };
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
    /** Always true — every step is reviewed. Kept for backward-compatible flow parsing. */
    required: boolean;
    /** Who performs the review: auto (AI) or human. Defaults to 'ai'. */
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
    /** Review-kit filename for the deep LLM review. Overrides the project-wide active kit
     *  (`review:activeKit` pref); unset falls back to that pref, then the bundled default. */
    reviewKit?: string;
    reviewers?: {
      type: "human" | "ai";
      agent?: string;
      skill?: string;
    }[];
    /** Legacy flag kept so old flow files still parse; it has no effect. */
    approvalRequired?: boolean;
    checklist?: string[];
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
  /**
   * Security level for headless runs.
   * - `'trusted'` (default): full file access via --dangerously-skip-permissions.
   * - `'sandboxed'`: Claude is restricted to only the files declared in `produces`.
   *   Any write outside of declared outputs will be blocked by the MCP layer.
   *   Use for untrusted or third-party flows.
   */
  trustLevel?: 'trusted' | 'sandboxed';
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
  /** Project-relative path of the review report file written when this step was approved or rejected. Unset if none. */
  reviewReportPath?: string;
  humanReview?: {
    decision: "approved" | "rejected";
    comment?: string;
    checklist?: Record<string, boolean>;
  };
  startedAt?: string;
  completedAt?: string;
  /** When the review phase ended (human/AI decision recorded). Review time = reviewCompletedAt − completedAt. */
  reviewCompletedAt?: string;
  /** Usage stats of the last execution; unset until the runner reports them. */
  tokensUsed?: number;
  modelUsed?: string;
  /** Cost (USD) of the last execution, taken from the run's own `result` event. */
  costUsd?: number;
  /** Claude CLI session id pinned for an interactive run, so metrics/output read exactly that session's .jsonl. */
  sessionId?: string;
}

export interface FlowRunState {
  flowId: string;
  runId: string;
  runName?: string;
  /** Human-readable flow name, captured at run creation so the run file can be named by slug. */
  flowName?: string;
  source: string;
  projectPath: string;
  inputs: Record<string, string>;
  steps: Record<string, StepRunState>;
  /** True when the run has been finalized ("Done Flow" or explicitly closed) and should not auto-resume. */
  isClosed?: boolean;
  /**
   * Master gate for AI review. When true, each completed auto (`review.type: 'ai'`) step is
   * AI-reviewed: a pass auto-confirms and advances, a rejection halts the run and writes a review
   * report. When false (default), NO AI review runs — an auto step instead waits for the user to
   * click "Finish" before advancing. Either way, human-review steps always wait for approve/reject.
   */
  autoReview?: boolean;
  /**
   * When true, a step launched in the Claude terminal auto-submits its pre-filled message
   * (as if the user pressed Enter). When false (default), the message is only pre-filled so the
   * user can review the agent/skill/model context and press Enter to start the run.
   */
  autoEnter?: boolean;
}
