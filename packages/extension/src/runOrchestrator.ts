import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess } from 'child_process';
import { ConfigManager } from './configManager.js';
import { StateManager } from './stateManager.js';
import { TerminalManager } from './terminalManager.js';
import { HostMessage, HistoryEvent } from './messages.js';
import { readInteractiveSessionStats } from './sessionStats.js';
import {
  Flow, FlowRunState, FlowStep, Skill,
  runClaudeStreaming, ClaudeStreamingRunOptions, ClaudeStreamingRunResult,
  validateProducesFiles, verifyProducesContent, validateRequires,
  renderRunReport,
  runValidator,
  renderVerifyReportMarkdown, verifyRun,
  isHeadlessStep, resolveMaxTurns, resolveTimeoutMs, buildHeadlessMcpConfig,
  StepRunState
} from '@ai-stepflow/core';
import * as machine from '@ai-stepflow/core';
import {
  StepRunContext,
  runHeadlessStep,
  runInteractiveStep,
  checkStepGuards,
} from './stepRunner.js';

/**
 * Owns the run state machine and every transition that drives it: launching a step (headless or
 * interactive), the two-layer review, cancel, mark-done, human review, the DAG auto-advance, plus
 * verify/report. Extracted from {@link CockpitPanel} so the panel is just message routing + view,
 * and so all run logic lives in one cohesive unit. The panel hands it the shared dependencies and
 * a `post` callback to reach the webview; the orchestrator is the authority on `currentFlow` and
 * `runState` — the panel reads them only for restore/cleanup, never mutates them directly.
 */
export class RunOrchestrator {
  private _currentFlow: Flow | undefined;
  private _runState: FlowRunState | undefined;
  /** Headless `claude -p` runs (AI-step execution + AI review) in flight, killed on dispose. */
  private _activeRuns = new Set<ChildProcess>();
  /** The in-flight headless child per step, so a "Cancel" can kill exactly that run. */
  private _runChildrenByStep = new Map<string, ChildProcess>();
  /** Steps the user cancelled, so the resolving run handler skips its own failure transition. */
  private _cancelledStepIds = new Set<string>();
  /** Steps already launched in the current run, so the DAG orchestrator never starts one twice. Reset when the runId changes. */
  private _startedStepIds = new Set<string>();
  /** Interactive steps we've already told the user are parked (waiting for the terminal), so the notice isn't repeated each advance. Reset with the run. */
  private _parkedStepIds = new Set<string>();
  /** Steps that have already consumed their one automatic AI-review retry this run. Reset when the runId changes. */
  private _autoRetryStepIds = new Set<string>();
  /** Timestamp when each interactive step started, used to locate its Claude session file. */
  private _stepStartTimes = new Map<string, Date>();
  private _bookkeepingRunId: string | undefined;
  private _stateUpdateQueue = Promise.resolve();

  /**
   * Per-run skills cache. Skills are read from disk once per run (populated on the first
   * headless step and reused by every parallel step that follows). Cleared whenever the
   * run ID changes so a reload in the middle of a run picks up new skills.
   */
  private _skillsCache: Skill[] | undefined;

  /**
   * Output streaming buffer: accumulate text chunks from headless `claude` runs and flush
   * them to the webview in a single postMessage per 50 ms tick. This prevents React from
   * re-rendering on every streamed token (LLMs emit ~10–30 chunks/s) and keeps the UI
   * responsive even during long-running steps.
   */
  private _outputChunkBuffer = new Map<string, string>();
  private _outputFlushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly stateManager: StateManager,
    private readonly terminals: TerminalManager,
    private readonly post: (message: HostMessage) => void
  ) {
    this.terminals.onDidCloseRunningStep(async stepId => {
      if (this._currentFlow && this._runState && this._runState.steps[stepId]?.executionStatus === 'running') {
        await this._setRunState(machine.markCancelled(this._runState, this._currentFlow, stepId), { stepId, status: 'cancelled', message: 'Terminal closed by user' });
        this.post({ type: 'stepUpdate', stepId, append: true, output: '\n[terminal closed — run cancelled]\n' });
      }
    });
    this.terminals.onDidEndRunningStep(async stepId => {
      if (!this._currentFlow || !this._runState) return;
      if (this._runState.steps[stepId]?.executionStatus !== 'running') return;
      const step = this._currentFlow.steps.find(s => s.id === stepId);
      const metrics = await this._readInteractiveMetrics(stepId);
      if (step?.review?.required) {
        await this._setRunState(s => machine.markCompleted(s, this._currentFlow!, stepId, metrics), { stepId, status: 'completed', message: 'Terminal session ended — reviewing' });
        await this._reviewStep(step, stepId);
      } else {
        await this._setRunState(s => machine.markDone(machine.markCompleted(s, this._currentFlow!, stepId, metrics), this._currentFlow!, stepId), { stepId, status: 'completed', message: 'Terminal work done' });
        this._advanceReadySteps();
      }
    });
  }

  get currentFlow(): Flow | undefined { return this._currentFlow; }
  get runState(): FlowRunState | undefined { return this._runState; }

  /** Replace the panel-selected flow/run mirror (loadFlow). No transition, no broadcast. */
  setFlowAndRunState(flow: Flow | undefined, runState: FlowRunState | undefined): void {
    this._currentFlow = flow;
    this._runState = runState;
  }

  /** Forget the current run if `flowId` is the one being deleted. */
  clearIfFlow(flowId: string): void {
    if (this._currentFlow?.id === flowId) {
      this._currentFlow = undefined;
      this._runState = undefined;
    }
  }

  /**
   * Persist a run state the webview pushed (updateRunState) without re-broadcasting it — the
   * webview already has it. Used for display-only mirror updates that aren't a transition.
   */
  async adoptRunState(runState: FlowRunState, historyEvent?: HistoryEvent): Promise<void> {
    this._runState = runState;
    await this.stateManager.saveRun(runState);
    if (historyEvent) {
      await this.stateManager.appendAuditLog(runState.flowId, runState.runId, historyEvent.stepId, {
        timestamp: historyEvent.timestamp,
        status: historyEvent.status,
        message: historyEvent.message
      });
    }
  }

  /** Restore the latest persisted run on panel open, broadcasting it to the webview. */
  async restore(): Promise<void> {
    let runState = this._runState;
    let flow = this._currentFlow;
    if (!runState) {
      runState = await this.stateManager.loadLatestRun();
      if (!runState) return;
      const flows = await this.configManager.loadFlows();
      flow = flows.find(f => f.id === runState!.flowId);
    }
    if (!flow || !runState) return;
    this._currentFlow = flow;
    this._runState = runState;
    this.post({ type: 'restoreRun', flow, runState });
  }

  /**
   * Entry point from the webview's "Run step". Seeds the backend's authoritative state — the
   * webview owns flow selection and the initial run state, but the backend takes ownership of
   * every transition from here on so a stale webview copy can never roll back a transition.
   */
  async runStep(stepId: string, opts: { flow?: Flow; runState?: FlowRunState; description?: string } = {}): Promise<void> {
    if (opts.flow) this._currentFlow = opts.flow;
    // Seed only for a new run; mid-run, the backend's own state wins.
    if (opts.runState && (!this._runState || this._runState.runId !== opts.runState.runId)) {
      this._runState = opts.runState;
    }
    await this._run(stepId, opts.description);
  }

  private async _run(stepId: string, description?: string): Promise<void> {
    if (!this._currentFlow || !this._runState) return;
    const flow = this._currentFlow;
    const step = flow.steps.find(s => s.id === stepId);
    if (!step) return;

    this._resetBookkeepingIfNewRun();

    const cleared = await checkStepGuards(
      stepId, step, flow, this._runState,
      (next, audit) => this._setRunState(next, audit),
      msg => this.post(msg),
      step => this._validateRequires(step)
    );
    if (!cleared) return;

    const agents = await this.configManager.loadAgents();
    const agent = agents.find(a => a.name === step.agent);
    const stepSkillNames = step.skills && step.skills.length ? step.skills : (step.skill ? [step.skill] : []);
    if (!agent || stepSkillNames.length === 0) return;

    this._startedStepIds.add(stepId);
    const projectPath = this.configManager.getProjectPath() || '';

    // Build the shared context object injected into runner functions.
    const ctx: StepRunContext = {
      flow,
      runState: this._runState,
      step,
      stepId,
      agent,
      stepSkillNames,
      skills: await this._getSkillsForRun(),
      projectPath,
      description,
      spawnClaudeStreaming: (opts, sid) => this._spawnClaudeStreaming(opts, sid),
      bufferOutput: (sid, chunk) => this._bufferOutput(sid, chunk),
      flushOutputBuffer: () => this._flushOutputBuffer(),
      setRunState: (next, audit) => this._setRunState(next, audit),
      patchStepState: (sid, patch) => this._patchStepState(sid, patch),
      consumeCancelledStep: sid => this._cancelledStepIds.delete(sid),
      post: msg => this.post(msg),
      advanceReadySteps: () => this._advanceReadySteps(),
      runAiReview: (s, sid, pp) => this._runAiReview(s, sid, pp),
      validateProduces: s => this._validateProduces(s),
      runMaxTurns: a => this._runMaxTurns(a),
      setStepStartTime: (sid, t) => this._stepStartTimes.set(sid, t),
    };

    if (isHeadlessStep(step)) {
      await runHeadlessStep(ctx);
    } else {
      await runInteractiveStep(ctx, this.terminals);
    }
  }

  /** Approve/reject a step from the webview's human-review buttons. */
  async reviewStep(stepId: string, decision: 'approved' | 'rejected'): Promise<void> {
    if (!this._currentFlow || !this._runState) return;
    const flow = this._currentFlow;
    const step = flow.steps.find(s => s.id === stepId);
    const isRunning = this._runState.steps[stepId]?.executionStatus === 'running';

    if (decision === 'approved') {
      if (step) {
        const prod = this._validateProduces(step);
        if (!prod.ok) {
          const msg = `produces check failed: ${prod.message}`;
          this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[cannot approve — ${msg}]\n` });
          vscode.window.showErrorMessage(`Cannot approve '${step.title || step.id}': ${prod.message}`);
          return;
        }
        const content = await this._verifyProducesContent(step);
        if (!content.ok) {
          this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[cannot approve — ${content.message}]\n` });
          vscode.window.showErrorMessage(`Cannot approve '${step.title || step.id}': ${content.message}`);
          return;
        }
      }

      if (isRunning) {
        // Terminal still running: mark done first (so close-terminal handler is a no-op), then close.
        const metrics = await this._readInteractiveMetrics(stepId);
        await this._setRunState(s => machine.markDone(machine.applyHumanReview(machine.markCompleted(s, flow, stepId, metrics), flow, stepId, { decision: 'approved' }), flow, stepId), { stepId, status: 'completed', message: 'Approved by user' });
        this.terminals.cancelStep(stepId);
        this._advanceReadySteps();
        return;
      }
    }

    if (decision === 'rejected' && isRunning) {
      // Terminal still running: mark completed then apply rejection so state is 'ready' before
      // closing terminal (prevents onDidCloseRunningStep from overwriting with 'cancelled').
      const metrics = await this._readInteractiveMetrics(stepId);
      await this._setRunState(s => machine.applyHumanReview(machine.markCompleted(s, flow, stepId, metrics), flow, stepId, { decision: 'rejected' }), { stepId, status: 'rejected', message: 'Rejected by user' });
      this.terminals.cancelStep(stepId);
      return;
    }

    // Terminal already ended: apply review decision to the completed step.
    await this._persistInteractiveMetrics(stepId);
    const review = { decision };
    await this._setRunState(s => machine.applyHumanReview(s, flow, stepId, review), { stepId, status: decision, message: `Human review ${decision}` });

    if (decision === 'approved' && this._runState.steps[stepId]?.completionStatus === 'done') {
      this._advanceReadySteps();
    }
  }

  /**
   * Finalize a step whose "Mark step done" was pressed. Gates requires/produces, then either
   * completes (no review needed, or already approved) and advances the DAG, or opens the review gate.
   */
  async markStepDone(stepId: string): Promise<void> {
    if (!this._currentFlow || !this._runState) return;
    const flow = this._currentFlow;
    const step = flow.steps.find(s => s.id === stepId);
    if (!step) return;

    const req = this._validateRequires(step);
    if (!req.ok) {
      this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[cannot mark done — requires check failed: ${req.message}]\n` });
      vscode.window.showErrorMessage(`Step '${step.title || step.id}' cannot be marked done: ${req.message}`);
      return;
    }
    const prod = this._validateProduces(step);
    if (!prod.ok) {
      this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[cannot mark done — produces check failed: ${prod.message}]\n` });
      vscode.window.showErrorMessage(`Step '${step.title || step.id}' cannot be marked done: ${prod.message}`);
      return;
    }
    const content = await this._verifyProducesContent(step);
    if (!content.ok) {
      this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[cannot mark done — ${content.message}]\n` });
      vscode.window.showErrorMessage(`Step '${step.title || step.id}' cannot be marked done: ${content.message}`);
      return;
    }

    const rs = this._runState.steps[stepId];
    // Non-review terminal step still running: the user clicked the "Done in terminal" button to signal
    // the terminal work is finished. Transition directly to 'done' and advance.
    if (!step.review?.required && rs?.executionStatus === 'running') {
      const metrics = await this._readInteractiveMetrics(stepId);
      await this._setRunState(s => machine.markDone(machine.markCompleted(s, flow, stepId, metrics), flow, stepId), { stepId, status: 'completed', message: 'Terminal work done' });
      this._advanceReadySteps();
      return;
    }
    // No review gate, or a reviewer already approved → finish and advance.
    if (!step.review?.required || rs?.reviewStatus === 'approved' || rs?.completionStatus === 'ready_to_mark_done') {
      await this._persistInteractiveMetrics(stepId);
      await this._setRunState(s => machine.markDone(s, flow, stepId), { stepId, status: 'completed', message: 'Marked done' });
      this._advanceReadySteps();
      return;
    }

    // Review required and not yet satisfied: record the run as completed (this opens the
    // review gate, setting reviewStatus to 'pending'), then run the artifact review or
    // wait for a human decision.
    await this._setRunState(s => machine.markCompleted(s, flow, stepId), { stepId, status: 'completed', message: 'Run completed — reviewing' });
    await this._reviewStep(step, stepId);
  }

  /** Reset the current run to a fresh state, terminating any in-flight processes. */
  async resetRun(): Promise<void> {
    if (!this._currentFlow || !this._runState) return;
    const flow = this._currentFlow;
    const oldSteps = this._runState.steps;

    // Mark headless runs cancelled so their completion handlers skip state transitions.
    for (const stepId of this._runChildrenByStep.keys()) {
      this._cancelledStepIds.add(stepId);
    }
    for (const child of this._activeRuns) child.kill();

    // Broadcast fresh state BEFORE disposing the terminal so that when onDidCloseRunningStep
    // fires, _runState is already freshState (step is 'ready') and the handler is a no-op.
    const oldRunId = this._runState.runId;
    const freshState = machine.initRunState(flow, {
      runId: new Date().toISOString(),
      projectPath: this._runState.projectPath,
      inputs: this._runState.inputs,
    });
    await Promise.all([
      this.stateManager.clearAuditLog(flow.id, oldRunId),
      this.stateManager.deleteRunFile(this._runState),
      this.stateManager.deleteReportFile(this._runState),
    ]);
    this.post({ type: 'resetAuditLog', flowId: flow.id });
    await this._setRunState(freshState);
    this.post({ type: 'restoreRun', flow, runState: freshState });
    this._resetBookkeepingIfNewRun();
    // Clear stale cancelled IDs so re-runs are not silently skipped.
    this._cancelledStepIds.clear();

    // Dispose any running terminal only after freshState is in place.
    for (const [stepId, state] of Object.entries(oldSteps)) {
      if (state.executionStatus === 'running') this.terminals.cancelStep(stepId);
    }
  }

  /** Clear the current active run from the cockpit view. */
  async closeRun(finalize?: boolean): Promise<void> {
    const flowId = this._currentFlow?.id;
    const runId = this._runState?.runId;
    if (this._runState) {
      if (finalize) {
        // When finalizing, mark the whole flow closed.
        this._runState = { ...this._runState, isClosed: true };
      }
      await this.stateManager.saveRun(this._runState);
    }
    this._currentFlow = undefined;
    this._runState = undefined;
    this._cancelledStepIds.clear();
    this._startedStepIds.clear();
    this._parkedStepIds.clear();
    this.post({ type: 'runClosed', flowId, runId, finalized: !!finalize });
  }

  /** Delete the current run: terminate in-flight processes, remove the saved file, notify the webview. */
  async deleteRun(): Promise<void> {
    if (!this._currentFlow || !this._runState) return;
    const flow = this._currentFlow;
    const runId = this._runState.runId;

    for (const stepId of this._runChildrenByStep.keys()) {
      this._cancelledStepIds.add(stepId);
    }
    for (const child of this._activeRuns) child.kill();

    await Promise.all([
      this.stateManager.clearAuditLog(flow.id, runId),
      this.stateManager.deleteRunFile(this._runState),
      this.stateManager.deleteReportFile(this._runState),
    ]);

    this._currentFlow = undefined;
    this._runState = undefined;
    this._cancelledStepIds.clear();
    this._startedStepIds.clear();
    this._parkedStepIds.clear();

    this.post({ type: 'runDeleted', flowId: flow.id, runId });
  }

  async verify(): Promise<void> {
    if (!this._currentFlow || !this._runState) return;
    const projectPath = this.configManager.getProjectPath();
    if (!projectPath) return;

    const report = verifyRun(this._currentFlow, this._runState, projectPath);
    if (report.ok) {
      vscode.window.showInformationMessage(`AI StepFlow: verify passed for run '${this._runState.runId}'.`);
      return;
    }

    const markdown = renderVerifyReportMarkdown(this._currentFlow, this._runState, report);
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showWarningMessage(`AI StepFlow: verify found drift in ${report.drift.length} step(s).`);
  }

  async exportReport(): Promise<void> {
    if (!this._currentFlow || !this._runState) return;
    const auditLog = await this.stateManager.loadAuditLog(this._currentFlow.id);
    const markdown = renderRunReport(this._currentFlow, this._runState, auditLog);
    const filePath = await this.stateManager.saveReport(this._runState, markdown);
    if (!filePath) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
    const base = filePath.split(/[\\/]/).pop();
    vscode.window.showInformationMessage(`AI StepFlow: run report exported to ${base}.`);
  }

  /** Terminate a step's running process (headless or terminal) and record it as cancelled. */
  async cancelStep(stepId: string): Promise<void> {
    const child = this._runChildrenByStep.get(stepId);
    if (child) {
      // Headless run — kill the tracked child process directly
      this._cancelledStepIds.add(stepId);
      child.kill();
      this.post({ type: 'stepUpdate', stepId, append: true, output: '\n[run cancelled by user]\n' });
      if (this._currentFlow && this._runState) {
        await this._setRunState(machine.markCancelled(this._runState, this._currentFlow, stepId), { stepId, status: 'cancelled', message: 'Cancelled by user' });
      }
      return;
    }
    // Terminal (interactive) run — mark cancelled first so onDidEndRunningStep is a no-op if it
    // fires during disposal, then dispose the terminal (onDidCloseRunningStep will set state).
    this._cancelledStepIds.add(stepId);
    const closed = this.terminals.cancelStep(stepId);
    if (closed) {
      this.post({ type: 'stepUpdate', stepId, append: true, output: '\n[run cancelled by user]\n' });
    }
  }

  /**
   * Run `claude` headless with stream-json output. The child process is tracked in `_activeRuns`
   * (killed on dispose) and, when a `stepId` is provided, in `_runChildrenByStep` so the user's
   * "Cancel" can kill exactly that run. A per-run timeout config bounds a hung run. Public so the
   * cockpit can reuse it for ad-hoc drafts and get the same timeout + dispose cleanup.
   */
  spawnClaudeStreaming(opts: ClaudeStreamingRunOptions, stepId?: string): Promise<ClaudeStreamingRunResult> {
    return this._spawnClaudeStreaming(opts, stepId);
  }

  /** Terminate every in-flight headless run. The cockpit owns terminal/panel cleanup. */
  dispose(): void {
    for (const child of this._activeRuns) child.kill();
  }

  // --- internals -----------------------------------------------------------

  /**
   * Commit a new authoritative run state: persist it and broadcast it to the webview, which
   * renders it without computing its own transitions. Optionally records an audit event.
   * All updates are queued to guarantee atomicity and prevent race conditions across concurrent runs.
   */
  private _setRunState(next: FlowRunState | ((prev: FlowRunState) => FlowRunState), audit?: { stepId: string; status: string; message?: string }): Promise<void> {
    const promise = this._stateUpdateQueue.then(async () => {
      if (!this._runState) return;
      const resolvedNext = typeof next === 'function' ? next(this._runState) : next;
      this._runState = resolvedNext;
      await this.stateManager.saveRun(resolvedNext);
      const historyEvent = audit ? { timestamp: new Date().toISOString(), ...audit } : undefined;
      if (historyEvent) {
        await this.stateManager.appendAuditLog(resolvedNext.flowId, resolvedNext.runId, historyEvent.stepId, {
          timestamp: historyEvent.timestamp,
          status: historyEvent.status,
          message: historyEvent.message
        });
      }
      this.post({ type: 'runStateChanged', runState: resolvedNext, historyEvent });
    });
    this._stateUpdateQueue = promise;
    return promise;
  }

  /**
   * Update the authoritative run state with a partial patch for one step, e.g. to accumulate
   * incremental output during a run without triggering a full state transition.
   */
  private async _patchStepState(stepId: string, patch: Partial<StepRunState>): Promise<void> {
    await this._setRunState(s => {
      const prev = s.steps[stepId];
      if (!prev) return s;
      return { ...s, steps: { ...s.steps, [stepId]: { ...prev, ...patch } } };
    });
  }

  /**
   * Gate a step completed via the interactive path ("Mark step done" pressed). AI-type reviews
   * run the two-layer auto-review; a step with an explicit `validatorPath` runs that validator;
   * everything else waits for a human decision.
   */
  private async _reviewStep(step: FlowStep, stepId: string): Promise<void> {
    const flow = this._currentFlow;
    if (!flow || !this._runState) return;
    const projectPath = this.configManager.getProjectPath() || '';
    const aiReview = step.review.type === 'ai' || !!step.review.reviewers?.some(r => r.type === 'ai');

    if (aiReview) {
      await this._runAiReview(step, stepId, projectPath);
      return;
    }
    if (step.review.validatorPath) {
      const verdict = await runValidator({ workspaceRoot: projectPath, step, runState: this._runState, stepOutput: '' });
      const status: 'approved' | 'rejected' = verdict.decision === 'pass' ? 'approved' : 'rejected';
      const note = `Validator review: ${status} — ${verdict.reason}`;
      await this._setRunState(machine.applyAiReview(this._runState, flow, stepId, status, note + '\n'), { stepId, status, message: `Validator review ${status}` });
      this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[${note}]\n` });
      if (status === 'approved') this._advanceReadySteps();
      return;
    }
    // Human-only review: wait for a decision via the approve/reject buttons. markCompleted
    // already set reviewStatus to 'pending', so the approve/reject UI is shown for this step.
    this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[review required — approve or reject this step to continue]\n` });
  }

  /**
   * Two-layer auto-review of a step's produced artifacts:
   *   1) a deterministic validator (.mjs) — cheap, certain (exists / non-empty / no TODO);
   *   2) an LLM reviewer that reads the artifacts against the adaptive default review kit.
   * A pass auto-marks the step done and advances; a rejection sends it back to ready. The validator
   * runs first so an obviously-incomplete artifact is rejected without spending review tokens.
   */
  private async _runAiReview(step: FlowStep, stepId: string, projectPath: string): Promise<void> {
    const flow = this._currentFlow;
    if (!flow || !this._runState) return;

    const deep = step.review.deep !== false;
    const reviewer = step.review.reviewers?.find(r => r.type === 'ai');
    const reviewerAgent = reviewer?.agent ? (await this.configManager.loadAgents()).find(a => a.name === reviewer.agent) : undefined;

    // Read the review kit + artifacts first so we only flip to the transient "review running"
    // state when an actual LLM call is going to happen.
    const reviewKit = deep ? machine.loadReviewKit(projectPath) : '';
    const artifacts = deep ? machine.readProducedArtifacts(step, projectPath, this._runState.inputs || {}, flow.name) : { text: '', count: 0 };
    if (deep && reviewKit && artifacts.count > 0) {
      await this._setRunState(s => machine.applyAiReview(s, flow, stepId, 'ai_review_running', ''));
    }

    let reviewOut = '';
    const result = await machine.reviewStepArtifacts({
      workspaceRoot: projectPath,
      step,
      runState: this._runState!,
      deep,
      reviewKit,
      artifacts,
      reviewModel: reviewerAgent?.model,
      runner: opts => this._spawnClaudeStreaming({ ...opts, maxTurns: 1 }),
      onText: chunk => { reviewOut += chunk; this.post({ type: 'aiReviewUpdate', stepId, append: true, output: chunk }); }
    });

    const detail = (reviewOut ? `${reviewOut}\n` : '') + `Review (${result.source}): ${result.status} — ${result.note}\n`;
    const reviewMetrics = (result.reviewTokensUsed != null || result.reviewCostUsd != null)
      ? { tokensUsed: result.reviewTokensUsed, costUsd: result.reviewCostUsd }
      : undefined;
    await this._setRunState(s => machine.applyAiReview(s, flow, stepId, result.status, detail, reviewMetrics), { stepId, status: result.status, message: `Review ${result.status}` });
    this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[review (${result.source}): ${result.status} — ${result.note}]\n` });

    if (result.status === 'approved') {
      this._advanceReadySteps();
    } else if (result.status === 'rejected' && result.source === 'validator' && !this._autoRetryStepIds.has(stepId)) {
      // Auto-retry only for a deterministic layer-1 validator rejection (a concrete, fixable
      // miss like a missing file or a leftover TODO). A subjective LLM rejection is surfaced to
      // the user instead, so we don't burn a full re-run + re-review on a verdict a retry is
      // unlikely to flip.
      this._autoRetryStepIds.add(stepId);
      this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[validator rejected — retrying automatically (1/1)]\n` });
      await this._run(stepId);
    }
    // LLM rejection, or a second validator rejection: leave in rejected state for the user.
  }

  /** Configured per-run timeout in ms (0 = no limit). */
  private _runTimeoutMs(): number {
    const seconds = vscode.workspace.getConfiguration('ai-stepflow').get<number>('run.timeoutSeconds', 600);
    return resolveTimeoutMs(seconds);
  }

  /** Max agentic turns for a headless run: agent-level override > global setting > default 6. */
  private _runMaxTurns(agent?: { maxTurns?: number }): number {
    const globalDefault = vscode.workspace.getConfiguration('ai-stepflow').get<number>('run.maxTurns', 6);
    return resolveMaxTurns(agent?.maxTurns, globalDefault);
  }

  /**
   * MCP config (a `{"mcpServers":{...}}` JSON string) for headless runs, built from the
   * `ai-stepflow.run.headlessMcpServers` allowlist. Default is empty — headless runs and AI
   * reviews carry no MCP servers, so their system context (and token cost) stays minimal.
   * Listed names are resolved against the user's ambient MCP config so an allowlisted server
   * keeps its real definition. Interactive terminal runs are unaffected.
   */
  private _headlessMcpConfig(): string {
    const allow = vscode.workspace.getConfiguration('ai-stepflow').get<string[]>('run.headlessMcpServers', []);
    if (!allow || allow.length === 0) return '{"mcpServers":{}}';
    return buildHeadlessMcpConfig(allow, this._readAmbientMcpServers());
  }

  /** Read MCP server definitions from the user's `~/.claude.json` (global + this project). Never throws. */
  private _readAmbientMcpServers(): Record<string, unknown> {
    try {
      const cfgPath = path.join(os.homedir(), '.claude.json');
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const global = raw?.mcpServers ?? {};
      const projectPath = this.configManager.getProjectPath();
      const project = projectPath ? (raw?.projects?.[projectPath]?.mcpServers ?? {}) : {};
      return { ...global, ...project };
    } catch {
      return {};
    }
  }

  private _spawnClaudeStreaming(opts: ClaudeStreamingRunOptions, stepId?: string): Promise<ClaudeStreamingRunResult> {
    const handle = runClaudeStreaming({ mcpConfig: this._headlessMcpConfig(), ...opts, timeoutMs: opts.timeoutMs ?? this._runTimeoutMs() });
    this._activeRuns.add(handle.child);
    if (stepId) this._runChildrenByStep.set(stepId, handle.child);
    return handle.completed.finally(() => {
      this._activeRuns.delete(handle.child);
      if (stepId && this._runChildrenByStep.get(stepId) === handle.child) this._runChildrenByStep.delete(stepId);
    });
  }

  private _validateRequires(step: FlowStep): { ok: boolean; message?: string } {
    return validateRequires(step, this.configManager.getProjectPath() || '', this._runState?.inputs || {}, this._currentFlow?.name || '');
  }

  /** Deterministic gate: the step's declared `produces`/review files must exist on disk. */
  private _validateProduces(step: FlowStep): { ok: boolean; message?: string } {
    return validateProducesFiles(step, this.configManager.getProjectPath() || '', this._runState?.inputs || {}, this._currentFlow?.name || '');
  }

  /**
   * Semantic gate: the produced files must satisfy the step's `producesContains` requirements.
   * Markers present verbatim pass for free; the rest are judged by an LLM (meaning, not exact
   * wording), so a draft need not echo the requirement text. Lenient on judge failure.
   */
  private _verifyProducesContent(step: FlowStep): Promise<{ ok: boolean; message?: string }> {
    return verifyProducesContent(
      step,
      this.configManager.getProjectPath() || '',
      this._runState?.inputs || {},
      this._currentFlow?.name || '',
      opts => this._spawnClaudeStreaming({ ...opts, maxTurns: 1 })
    );
  }

  /** True when a step runs headless (AI review), so it has no shared UI and can run concurrently. */
  private _isHeadlessStep(step: FlowStep): boolean {
    return isHeadlessStep(step);
  }

  /**
   * Auto-run dependent steps once their dependencies are done (DAG orchestrator). On a
   * fan-out, each headless/AI branch launches concurrently — they have no shared UI.
   * Interactive (human/terminal) steps share one chat box, so only the first launches; the rest
   * are parked with a one-time message until a terminal slot frees up.
   */
  private _advanceReadySteps(): void {
    if (!this._currentFlow || !this._runState) return;
    const orch = new machine.FlowOrchestrator(this._currentFlow, this._runState);
    const actions = orch.getAutoAdvanceActions();
    this._startedStepIds = orch.getStartedStepIds();

    for (const action of actions) {
      if (action.type === 'launch_headless') {
        void this._run(action.stepId);
      } else if (action.type === 'launch_interactive' || action.type === 'park_interactive') {
        // Interactive (human-review) steps are never auto-launched: the user must click "Run Step".
        // We just notify once that the step is ready and waiting.
        if (this._parkedStepIds.has(action.stepId)) continue;
        this._parkedStepIds.add(action.stepId);
        this.post({ type: 'stepUpdate', stepId: action.stepId, append: true, output: '\n[step ready — click "Run Step" to start]\n' });
      }
    }
  }

  /** Read session stats from Claude CLI's .jsonl files for an interactive step. Never throws. */
  private async _readInteractiveMetrics(stepId: string): Promise<machine.StepMetrics> {
    const startTime = this._stepStartTimes.get(stepId)
      ?? (this._runState?.steps[stepId]?.startedAt ? new Date(this._runState.steps[stepId].startedAt!) : undefined);
    const projectPath = this.configManager.getProjectPath();
    if (!startTime || Number.isNaN(startTime.getTime()) || !projectPath) return {};
    const sessionId = this._runState?.steps[stepId]?.sessionId;
    return readInteractiveSessionStats(projectPath, startTime, sessionId);
  }

  /** Persist recovered interactive metrics onto the step so the run JSON is the single UI source of truth. */
  private async _persistInteractiveMetrics(stepId: string): Promise<void> {
    if (!this._runState) return;

    const metrics = await this._readInteractiveMetrics(stepId);
    const hasMetrics = metrics.modelUsed != null || metrics.tokensUsed != null || metrics.costUsd != null || !!metrics.output;
    if (!hasMetrics) return;

    const prev = this._runState.steps[stepId];
    if (!prev) return;

    const nextModelUsed = metrics.modelUsed ?? prev.modelUsed;
    const nextTokensUsed = metrics.tokensUsed ?? prev.tokensUsed;
    const nextCostUsd = metrics.costUsd ?? prev.costUsd;
    const nextOutput = (metrics.output && metrics.output.length > 0) ? metrics.output : prev.output;
    const changed = nextModelUsed !== prev.modelUsed
      || nextTokensUsed !== prev.tokensUsed
      || nextCostUsd !== prev.costUsd
      || nextOutput !== prev.output;
    if (!changed) return;

    await this._setRunState(s => ({
      ...s,
      steps: {
        ...s.steps,
        [stepId]: {
          ...s.steps[stepId],
          modelUsed: nextModelUsed,
          tokensUsed: nextTokensUsed,
          costUsd: nextCostUsd,
          output: nextOutput,
        }
      }
    }));
  }

  /**
   * Return the skills list for this run, loading from disk only on the first call per run.
   * Parallel headless steps all share one read; clearing `_skillsCache` in
   * `_resetBookkeepingIfNewRun` ensures a new run always sees fresh skills.
   */
  private async _getSkillsForRun(): Promise<Skill[]> {
    if (!this._skillsCache) {
      this._skillsCache = await this.configManager.loadSkills();
    }
    return this._skillsCache;
  }

  /**
   * Accumulate a streamed output chunk for `stepId` and schedule a flush. The 50 ms
   * batch window prevents React from re-rendering on every token the LLM emits while
   * keeping perceived latency well within acceptable limits for a developer tool.
   */
  private _bufferOutput(stepId: string, chunk: string): void {
    this._outputChunkBuffer.set(stepId, (this._outputChunkBuffer.get(stepId) ?? '') + chunk);
    if (!this._outputFlushTimer) {
      this._outputFlushTimer = setTimeout(() => this._flushOutputBuffer(), 50);
    }
  }

  /**
   * Flush all buffered output chunks to the webview in one postMessage per step, then
   * clear the buffer. Called by the 50 ms timer and also immediately at the end of each
   * run so the final tail of output is never left in the buffer.
   */
  private _flushOutputBuffer(): void {
    if (this._outputFlushTimer) {
      clearTimeout(this._outputFlushTimer);
      this._outputFlushTimer = undefined;
    }
    for (const [stepId, text] of this._outputChunkBuffer) {
      if (text) this.post({ type: 'stepUpdate', stepId, append: true, output: text });
    }
    this._outputChunkBuffer.clear();
  }

  private _resetBookkeepingIfNewRun(): void {
    const runId = this._runState?.runId;
    if (runId === this._bookkeepingRunId) return;
    this._bookkeepingRunId = runId;
    this._startedStepIds = this._runState ? machine.seedStartedSteps(this._runState.steps) : new Set<string>();
    this._parkedStepIds = new Set<string>();
    this._autoRetryStepIds = new Set<string>();
    this._stepStartTimes = new Map<string, Date>();
    // Clear per-run caches so a new run always sees fresh data.
    this._skillsCache = undefined;
    this._flushOutputBuffer();
  }
}
