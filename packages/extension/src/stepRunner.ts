/**
 * stepRunner.ts — Headless and interactive step execution helpers.
 *
 * These functions contain the core execution logic for both headless
 * (AI-reviewed, spawned as `claude -p`) and interactive (terminal) steps.
 * They are extracted from RunOrchestrator to keep that class focused on
 * state management and public API surface only.
 */
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { ConfigManager } from './configManager.js';
import type { TerminalManager } from './terminalManager.js';
import type { HostMessage } from './messages.js';
import type { FlowRunState, Flow, FlowStep, Agent, Skill } from '@ai-stepflow/core';
import {
  composeSystemPromptParts,
  resolveTemplate, resolveTemplates, resolveFlowRelativePath,
  ClaudeStreamingRunOptions, ClaudeStreamingRunResult,
} from '@ai-stepflow/core';
import * as machine from '@ai-stepflow/core';

// ---------------------------------------------------------------------------
// Shared context passed from RunOrchestrator into each runner function.
// ---------------------------------------------------------------------------

export interface StepRunContext {
  flow: Flow;
  runState: FlowRunState;
  step: FlowStep;
  stepId: string;
  agent: Agent;
  stepSkillNames: string[];
  skills: Skill[];
  projectPath: string;
  description?: string;
  /** Spawn a headless claude process, tracked for cancel/dispose. */
  spawnClaudeStreaming(opts: ClaudeStreamingRunOptions, stepId?: string): Promise<ClaudeStreamingRunResult>;
  /** Queue a streamed output chunk (50 ms batch → single postMessage). */
  bufferOutput(stepId: string, chunk: string): void;
  /** Immediately flush any buffered chunks to the webview. */
  flushOutputBuffer(): void;
  /** Atomic run state transition + persist + broadcast. */
  setRunState(next: FlowRunState | ((prev: FlowRunState) => FlowRunState), audit?: { stepId: string; status: string; message?: string }): Promise<void>;
  /** Partial step-state patch (incremental output accumulation). */
  patchStepState(stepId: string, patch: Partial<FlowRunState['steps'][string]>): Promise<void>;
  /** True when this stepId was cancelled by the user mid-run. Deletes from the set. */
  consumeCancelledStep(stepId: string): boolean;
  /** Post a raw HostMessage to the webview. */
  post(message: HostMessage): void;
  /** Advance DAG: launch/park next ready steps. */
  advanceReadySteps(): void;
  /** Run the two-layer AI review for a step. */
  runAiReview(step: FlowStep, stepId: string, projectPath: string): Promise<void>;
  /** Validate that `produces` files exist (post-run check). */
  validateProduces(step: FlowStep): { ok: boolean; message?: string };
  /** Max turns for this agent's headless run. */
  runMaxTurns(agent: Agent): number;
  /** Record that this interactive step started at the given time. */
  setStepStartTime(stepId: string, time: Date): void;
}

// ---------------------------------------------------------------------------
// Headless step runner
// ---------------------------------------------------------------------------

/**
 * Launch a headless `claude -p` run for a step that has AI review enabled.
 * The process is observable (exits when done), so we collect its output,
 * run the two-layer review, and advance the DAG automatically — no human
 * interaction required.
 */
export async function runHeadlessStep(ctx: StepRunContext): Promise<void> {
  const { flow, step, stepId, agent, stepSkillNames, skills, projectPath, description } = ctx;
  const runInputs = ctx.runState.inputs || {};

  // Relative paths for the agent prompt (cleaner than full system paths).
  const resolvedProduces = resolveTemplates(step.produces, runInputs)
    .map(p => resolveFlowRelativePath(p, flow.name));
  const resolvedRequires = resolveTemplates(step.requires, runInputs)
    .map(p => resolveFlowRelativePath(p, flow.name));

  // Split into stable (cacheable) + dynamic (per-run) system prompt parts.
  const promptParts = composeSystemPromptParts(
    agent, stepSkillNames, skills, resolvedProduces, runInputs, resolvedRequires, step.producesContains
  );
  const userMessage = resolveTemplate(
    description?.trim() || step.input?.prompt?.trim() || `Run step: ${step.title || step.id}`,
    runInputs
  );

  // Security: sandboxed flows restrict Claude to only the declared produces paths.
  // Pass the workspace-relative produces paths (the run cwd is projectPath, which is how
  // Claude's permission matcher resolves the Write/Edit allow-rules).
  const isSandboxed = flow.trustLevel === 'sandboxed';
  const allowedWritePaths = isSandboxed ? resolvedProduces : undefined;

  if (isSandboxed) {
    ctx.post({ type: 'stepUpdate', stepId, append: true, output: `\n[sandboxed run — writes restricted to declared produces]\n` });
  }

  await ctx.setRunState(
    s => machine.markRunning(s, flow, stepId),
    { stepId, status: 'running', message: 'Run started (headless)' }
  );

  let output = '';
  const result = await ctx.spawnClaudeStreaming({
    systemPrompt: promptParts.static,
    dynamicSystemPrompt: promptParts.dynamic,
    userMessage,
    model: agent.model,
    projectPath,
    maxTurns: ctx.runMaxTurns(agent),
    allowedWritePaths,
    onText: chunk => {
      output += chunk;
      ctx.bufferOutput(stepId, chunk);
      void ctx.patchStepState(stepId, { output });
    },
  }, stepId);

  // Flush any remaining buffered chunks immediately on run end.
  ctx.flushOutputBuffer();

  // User cancelled: cancelStep already moved the step to 'cancelled', skip failure.
  if (ctx.consumeCancelledStep(stepId)) return;

  const metrics: machine.StepMetrics = {
    modelUsed: result.model,
    tokensUsed: result.tokensUsed,
    costUsd: result.costUsd,
    output,
  };

  if (!result.success) {
    const why = result.timedOut ? 'run timed out' : `claude exited ${result.exitCode}`;
    await ctx.setRunState(
      s => machine.markFailed(s, flow, stepId, {
        ...metrics,
        error: why,
        output: output + `\n[step failed: ${why}]\n`,
      }),
      { stepId, status: 'failed', message: result.timedOut ? 'Run timed out' : 'Run failed' }
    );
    return;
  }

  const prod = ctx.validateProduces(step);
  if (!prod.ok) {
    await ctx.setRunState(
      s => machine.markFailed(s, flow, stepId, {
        ...metrics,
        error: `produces check failed: ${prod.message}`,
        output: output + `\n[produces check failed: ${prod.message}]\n`,
      }),
      { stepId, status: 'failed', message: `Produces check failed: ${prod.message}` }
    );
    return;
  }

  const reviewMsg = step.review?.required ? 'Run completed — reviewing' : 'Run completed';
  await ctx.setRunState(
    s => machine.markCompleted(s, flow, stepId, { ...metrics, output }),
    { stepId, status: 'completed', message: reviewMsg }
  );

  if (step.review?.required) {
    await ctx.runAiReview(step, stepId, projectPath);
  } else {
    ctx.advanceReadySteps();
  }
}

// ---------------------------------------------------------------------------
// Interactive step runner
// ---------------------------------------------------------------------------

/**
 * Open a terminal-based interactive Claude session for a step without AI
 * review. The pre-filled message is passed to the terminal manager; the user
 * presses Enter to start the run. The backend listens for the terminal
 * close/end events to capture metrics and advance the DAG.
 */
export async function runInteractiveStep(
  ctx: StepRunContext,
  terminals: TerminalManager
): Promise<void> {
  const { flow, step, stepId, agent, stepSkillNames, projectPath, description } = ctx;
  const runInputs = ctx.runState.inputs || {};

  const resolvedProduces = resolveTemplates(step.produces, runInputs)
    .map(p => resolveFlowRelativePath(p, flow.name));
  const resolvedRequires = resolveTemplates(step.requires, runInputs)
    .map(p => resolveFlowRelativePath(p, flow.name));

  const primarySkill = stepSkillNames[0];
  const desc = resolveTemplate(
    description?.trim() || step.input?.prompt?.trim() || `Run step: ${step.title || step.id}`,
    runInputs
  );

  let message = primarySkill ? `/${primarySkill} ${desc}` : desc;
  if (resolvedRequires.length > 0) {
    message += `\n\nMandatory input files (relative to workspace root, read these first):\n${resolvedRequires.map(p => `- ${p}`).join('\n')}`;
  }
  if (resolvedProduces.length > 0) {
    message += `\n\nMandatory output files (relative to workspace root, you MUST create these):\n${resolvedProduces.map(p => `- ${p}`).join('\n')}`;
  }

  ctx.setStepStartTime(stepId, new Date());
  const sessionId = randomUUID();

  await ctx.setRunState(
    s => machine.markRunning(s, flow, stepId),
    { stepId, status: 'running', message: 'Opened in Claude — press Enter to run' }
  );
  await ctx.patchStepState(stepId, { sessionId });
  ctx.post({
    type: 'stepUpdate',
    stepId,
    append: true,
    output: '\n[opened in the Claude terminal — review the pre-filled message, press Enter to run]\n',
  });

  await terminals.runInTerminal(message, projectPath, agent, false, stepId, sessionId);
}

// ---------------------------------------------------------------------------
// Step guard helpers (shared by both paths)
// ---------------------------------------------------------------------------

/**
 * Check all pre-run guards for a step: dependency locks, missing dependsOn,
 * and requires-file validation. Returns `true` if the step is cleared to run,
 * `false` (and posts an error message) if any guard fails.
 */
export async function checkStepGuards(
  stepId: string,
  step: FlowStep,
  flow: Flow,
  runState: FlowRunState,
  setRunState: StepRunContext['setRunState'],
  post: StepRunContext['post'],
  validateRequires: (step: FlowStep) => { ok: boolean; message?: string }
): Promise<boolean> {
  // Apply dependency locks and persist if the lock set changed.
  const lockedSteps = machine.applyDependencyLocks(flow, runState.steps);
  if (!machine.lockStatesEqual(lockedSteps, runState.steps)) {
    await setRunState({ ...runState, steps: lockedSteps });
  }

  if (lockedSteps[stepId]?.executionStatus === 'locked') {
    const message = 'complete the dependency steps first';
    post({ type: 'stepUpdate', stepId, append: true, output: `\n[step blocked — ${message}]\n` });
    vscode.window.showErrorMessage(`Step '${step.title || step.id}' is locked: ${message}.`);
    return false;
  }

  const deps = step.dependsOn ?? [];
  const done = machine.doneStepIds(runState);
  const missingDeps = deps.filter(d => !done.has(d));
  if (missingDeps.length) {
    const message = `dependency step(s) not done: ${missingDeps.join(', ')}`;
    post({ type: 'stepUpdate', stepId, append: true, output: `\n[step blocked — ${message}]\n` });
    vscode.window.showErrorMessage(`Step '${step.title || step.id}' is blocked: ${message}.`);
    return false;
  }

  const req = validateRequires(step);
  if (!req.ok) {
    post({ type: 'stepUpdate', stepId, append: true, output: `\n[step blocked — ${req.message}]\n` });
    vscode.window.showErrorMessage(`Step '${step.title || step.id}' is blocked: ${req.message}`);
    return false;
  }

  return true;
}

/**
 * True when a step runs headless (AI-reviewed) — it has no shared UI and
 * can execute concurrently with other headless steps.
 */
export function isHeadlessStep(step: FlowStep): boolean {
  return !!step.review?.required &&
    (step.review.type === 'ai' || !!step.review.reviewers?.some(r => r.type === 'ai'));
}

export { ConfigManager };
