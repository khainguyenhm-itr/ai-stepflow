import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';
import { ConfigManager } from './configManager.js';
import { StateManager } from './stateManager.js';
import { TerminalManager } from './terminalManager.js';
import { HostMessage, HumanReview, HistoryEvent } from './messages.js';
import {
  Flow, FlowRunState, FlowStep,
  runClaudeStreaming, ClaudeStreamingRunOptions, ClaudeStreamingRunResult, composeSystemPrompt,
  validateProduces, validateRequires,
  renderRunReport,
  pickAutoAdvanceSteps,
  seedStartedSteps,
  runValidator,
  renderVerifyReportMarkdown, verifyRun,
  resolveTemplate, resolveTemplates
} from '@ai-stepflow/core';
import * as machine from '@ai-stepflow/core';

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
  private _bookkeepingRunId: string | undefined;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly stateManager: StateManager,
    private readonly terminals: TerminalManager,
    private readonly post: (message: HostMessage) => void
  ) {
    this.terminals.onDidCloseRunningStep(stepId => {
      if (this._currentFlow && this._runState && this._runState.steps[stepId]?.executionStatus === 'running') {
        this._setRunState(machine.markCancelled(this._runState, this._currentFlow, stepId), { stepId, status: 'cancelled', message: 'Terminal closed by user' });
        this.post({ type: 'stepUpdate', stepId, append: true, output: '\n[terminal closed — run cancelled]\n' });
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
   * every transition from here on so a stale webview mirror can never roll a transition back.
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

    const lockedSteps = machine.applyDependencyLocks(flow, this._runState.steps);
    if (!machine.lockStatesEqual(lockedSteps, this._runState.steps)) {
      this._setRunState({ ...this._runState, steps: lockedSteps });
    }
    const stepState = lockedSteps[stepId];
    if (stepState?.executionStatus === 'locked') {
      const message = 'complete the dependency steps first';
      this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[step blocked — ${message}]\n` });
      vscode.window.showErrorMessage(`Step '${step.title || step.id}' is locked: ${message}.`);
      return;
    }

    // Never start a step before the steps it depends on are done — the backend is the
    // authority, so auto-advanced and hand-clicked runs share one guard against the run state.
    const deps = step.dependsOn ?? [];
    const done = machine.doneStepIds(this._runState);
    const missingDeps = deps.filter(d => !done.has(d));
    if (missingDeps.length) {
      const message = `dependency step(s) not done: ${missingDeps.join(', ')}`;
      this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[step blocked — ${message}]\n` });
      vscode.window.showErrorMessage(`Step '${step.title || step.id}' is blocked: ${message}.`);
      return;
    }

    const req = this._validateRequires(step);
    if (!req.ok) {
      this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[step blocked — ${req.message}]\n` });
      vscode.window.showErrorMessage(`Step '${step.title || step.id}' is blocked: ${req.message}`);
      return;
    }

    const agents = await this.configManager.loadAgents();
    const agent = agents.find(a => a.name === step.agent);
    const stepSkillNames = step.skills && step.skills.length ? step.skills : (step.skill ? [step.skill] : []);
    if (!agent || stepSkillNames.length === 0) return;

    this._startedStepIds.add(stepId);
    const projectPath = this.configManager.getProjectPath() || '';

    const aiReview = this._isHeadlessStep(step);

    // AI-reviewed steps run HEADLESS so the run completion is observable: when claude exits we
    // capture the output, then automatically run the two-layer review and auto-advance on a pass
    // — no Enter, no "Mark step done" click.
    if (aiReview) {
      const skills = await this.configManager.loadSkills();
      const runInputs = this._runState?.inputs || {};
      const resolvedProduces = resolveTemplates(step.produces, runInputs);
      const systemPrompt = composeSystemPrompt(agent, stepSkillNames, skills, resolvedProduces, runInputs);
      const userMessage = resolveTemplate(description?.trim() || step.input?.prompt?.trim() || `Run step: ${step.title || step.id}`, runInputs);
      this._setRunState(machine.markRunning(this._runState, flow, stepId), { stepId, status: 'running', message: 'Run started (headless, auto-review)' });

      let output = '';
      const result = await this._spawnClaudeStreaming({
        systemPrompt, userMessage, model: agent.model, projectPath,
        onText: chunk => { output += chunk; this.post({ type: 'stepUpdate', stepId, append: true, output: chunk }); }
      }, stepId);
      // The user cancelled this run: cancelStep already moved the step to 'cancelled',
      // so don't also record a failure for the kill that cancel triggered.
      if (this._cancelledStepIds.delete(stepId)) return;
      const metrics: machine.StepMetrics = { modelUsed: result.model, tokensUsed: result.tokensUsed, costUsd: result.costUsd, output };
      if (!result.success) {
        const why = result.timedOut ? 'run timed out' : `claude exited ${result.exitCode}`;
        this._setRunState(machine.markFailed(this._runState, flow, stepId, { ...metrics, output: output + `\n[step failed: ${why}]\n` }), { stepId, status: 'failed', message: result.timedOut ? 'Run timed out' : 'Run failed' });
        return;
      }
      const prod = this._validateProduces(step);
      if (!prod.ok) {
        this._setRunState(machine.markFailed(this._runState, flow, stepId, { ...metrics, output: output + `\n[produces check failed: ${prod.message}]\n` }), { stepId, status: 'failed', message: `Produces check failed: ${prod.message}` });
        return;
      }
      this._setRunState(machine.markCompleted(this._runState, flow, stepId, metrics), { stepId, status: 'completed', message: 'Run completed — reviewing' });
      await this._runAiReview(step, stepId, projectPath);
      return;
    }

    // Human / no-review steps run INTERACTIVELY: open Claude with `--agent --model`, pre-fill the
    // chat box with the step's skill + description WITHOUT submitting. The user presses Enter to
    // run, then clicks "Mark step done" to advance.
    const primarySkill = stepSkillNames[0];
    const desc = resolveTemplate(description?.trim() || step.input?.prompt?.trim() || `Run step: ${step.title || step.id}`, this._runState?.inputs || {});
    const message = primarySkill ? `/${primarySkill} ${desc}` : desc;

    this._setRunState(machine.markRunning(this._runState, flow, stepId), { stepId, status: 'running', message: 'Opened in Claude — press Enter to run' });
    this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[opened in the Claude terminal — review the pre-filled message, press Enter to run, then click "Mark step done"]\n` });
    await this.terminals.runInTerminal(message, projectPath, agent, false);
  }

  /** Approve/reject a step from the webview's human-review buttons. */
  reviewStep(stepId: string, decision: 'approved' | 'rejected'): void {
    if (!this._currentFlow || !this._runState) return;
    const flow = this._currentFlow;
    const review = { decision };
    this._setRunState(machine.applyHumanReview(this._runState, flow, stepId, review), { stepId, status: decision, message: `Human review ${decision}` });
    
    // If approved and not waiting for manual confirmation, advance the DAG.
    if (decision === 'approved' && this._runState.steps[stepId]?.completionStatus === 'done') {
      this._advanceReadySteps();
    }
  }

  /**
   * Finish a step clicked "Mark step done". Gates on requires/produces, then either completes
   * (no review or already approved) and advances the DAG, or opens the review gate.
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

    const rs = this._runState.steps[stepId];
    // Non-review terminal step still running: the user clicked the "Done in terminal" button to signal
    // the terminal work is finished. Transition running → completed (which auto-marks done when
    // requireMarkDone is false; otherwise the "Mark done" button appears for the final confirmation).
    if (!step.review?.required && rs?.executionStatus === 'running') {
      this._setRunState(machine.markCompleted(this._runState, flow, stepId), { stepId, status: 'completed', message: 'Terminal work done' });
      if (this._runState.steps[stepId]?.completionStatus === 'done') this._advanceReadySteps();
      return;
    }
    // No review gate, or a reviewer already approved → finish and advance.
    if (!step.review?.required || rs?.reviewStatus === 'approved' || rs?.completionStatus === 'ready_to_mark_done') {
      this._setRunState(machine.markDone(this._runState, flow, stepId), { stepId, status: 'completed', message: 'Marked done' });
      this._advanceReadySteps();
      return;
    }

    // Review required and not yet satisfied: record the run as completed (this opens the
    // review gate, setting reviewStatus to 'pending'), then run the artifact review or
    // wait for a human decision.
    this._setRunState(machine.markCompleted(this._runState, flow, stepId), { stepId, status: 'completed', message: 'Run completed — reviewing' });
    await this._reviewStep(step, stepId);
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
    const filePath = await this.stateManager.saveReport(this._currentFlow.id, this._runState.runId, markdown);
    if (!filePath) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
    const base = filePath.split(/[\\/]/).pop();
    vscode.window.showInformationMessage(`AI StepFlow: run report exported to ${base}.`);
  }

  /** Kill the in-flight headless run for a step and record it as cancelled. No-op for terminal runs. */
  cancelStep(stepId: string): void {
    const child = this._runChildrenByStep.get(stepId);
    if (!child) return;
    this._cancelledStepIds.add(stepId);
    child.kill();
    this.post({ type: 'stepUpdate', stepId, append: true, output: '\n[run cancelled by user]\n' });
    if (this._currentFlow && this._runState) {
      this._setRunState(machine.markCancelled(this._runState, this._currentFlow, stepId), { stepId, status: 'cancelled', message: 'Cancelled by user' });
    }
  }

  /**
   * Run `claude` headless with stream-json output. The child is tracked in `_activeRuns`
   * (killed on dispose) and, when a `stepId` is given, in `_runChildrenByStep` so a user
   * "Cancel" can kill exactly that run. A configured per-run timeout caps a hung run. Public so
   * the panel can reuse it for ad-hoc drafts and get the same timeout + dispose cleanup.
   */
  spawnClaudeStreaming(opts: ClaudeStreamingRunOptions, stepId?: string): Promise<ClaudeStreamingRunResult> {
    return this._spawnClaudeStreaming(opts, stepId);
  }

  /** Kill every in-flight headless run. The panel owns terminal/panel disposal. */
  dispose(): void {
    for (const child of this._activeRuns) child.kill();
  }

  // --- internals -----------------------------------------------------------

  /**
   * Adopt a new authoritative run state: persist it and broadcast it to the webview, which
   * renders it without computing transitions of its own. Optionally records an audit event.
   */
  private _setRunState(next: FlowRunState, audit?: { stepId: string; status: string; message?: string }): void {
    this._runState = next;
    void this.stateManager.saveRun(next);
    const historyEvent = audit ? { timestamp: new Date().toISOString(), ...audit } : undefined;
    if (historyEvent) {
      void this.stateManager.appendAuditLog(next.flowId, next.runId, historyEvent.stepId, { timestamp: historyEvent.timestamp, status: historyEvent.status, message: historyEvent.message });
    }
    this.post({ type: 'runStateChanged', runState: next, historyEvent });
  }

  /**
   * Gate a step finished via the interactive path (clicked "Mark step done"). AI-type reviews
   * run the two-layer automated review; a step with an explicit `validatorPath` runs that
   * validator; everything else waits for a human decision.
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
      this._setRunState(machine.applyAiReview(this._runState, flow, stepId, status, note + '\n'), { stepId, status, message: `Validator review ${status}` });
      this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[${note}]\n` });
      if (status === 'approved') this._advanceReadySteps();
      return;
    }
    // Human-only review: wait for a decision via the approve/reject buttons. markCompleted
    // already set reviewStatus to 'pending', so the approve/reject UI is shown for this step.
    this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[review required — approve or reject this step to continue]\n` });
  }

  /**
   * Two-layer automated review of a step's produced artifacts:
   *   1) a deterministic validator (.mjs) — cheap, certain (exists / non-empty / no TODO);
   *   2) an LLM reviewer that reads the artifacts against the adaptive default review kit.
   * A pass auto-marks the step done and advances; a reject sends it back to ready. The validator
   * runs first so an obviously-incomplete artifact is rejected without spending review tokens.
   */
  private async _runAiReview(step: FlowStep, stepId: string, projectPath: string): Promise<void> {
    const flow = this._currentFlow;
    if (!flow || !this._runState) return;

    const deep = step.review.deep !== false;
    const reviewer = step.review.reviewers?.find(r => r.type === 'ai');
    const reviewerAgent = reviewer?.agent ? (await this.configManager.loadAgents()).find(a => a.name === reviewer.agent) : undefined;

    // Read the kit + artifacts up front so we only flip to the transient "review running" state
    // when an actual LLM call will happen.
    const reviewKit = deep ? machine.loadReviewKit(projectPath) : '';
    const artifacts = deep ? machine.readProducedArtifacts(step, projectPath, this._runState.inputs || {}) : { text: '', count: 0 };
    if (deep && reviewKit && artifacts.count > 0) {
      this._setRunState(machine.applyAiReview(this._runState, flow, stepId, 'ai_review_running', ''));
    }

    let reviewOut = '';
    const result = await machine.reviewStepArtifacts({
      workspaceRoot: projectPath,
      step,
      runState: this._runState,
      deep,
      reviewKit,
      artifacts,
      reviewModel: reviewerAgent?.model,
      runner: opts => this._spawnClaudeStreaming(opts),
      onText: chunk => { reviewOut += chunk; this.post({ type: 'aiReviewUpdate', stepId, append: true, output: chunk }); }
    });

    const detail = (reviewOut ? `${reviewOut}\n` : '') + `Review (${result.source}): ${result.status} — ${result.note}\n`;
    this._setRunState(machine.applyAiReview(this._runState, flow, stepId, result.status, detail), { stepId, status: result.status, message: `Review ${result.status}` });
    this.post({ type: 'stepUpdate', stepId, append: true, output: `\n[review (${result.source}): ${result.status} — ${result.note}]\n` });
    if (result.status === 'approved') this._advanceReadySteps();
  }

  /** Configured per-run timeout in ms (0 = no limit). */
  private _runTimeoutMs(): number {
    const seconds = vscode.workspace.getConfiguration('ai-stepflow').get<number>('run.timeoutSeconds', 600);
    return seconds > 0 ? seconds * 1000 : 0;
  }

  private _spawnClaudeStreaming(opts: ClaudeStreamingRunOptions, stepId?: string): Promise<ClaudeStreamingRunResult> {
    const handle = runClaudeStreaming({ ...opts, timeoutMs: opts.timeoutMs ?? this._runTimeoutMs() });
    this._activeRuns.add(handle.child);
    if (stepId) this._runChildrenByStep.set(stepId, handle.child);
    return handle.completed.finally(() => {
      this._activeRuns.delete(handle.child);
      if (stepId && this._runChildrenByStep.get(stepId) === handle.child) this._runChildrenByStep.delete(stepId);
    });
  }

  private _validateRequires(step: FlowStep): { ok: boolean; message?: string } {
    return validateRequires(step, this.configManager.getProjectPath() || '', this._runState?.inputs || {});
  }

  /** Verify a step's declared `produces` files exist and contain any required markers. */
  private _validateProduces(step: FlowStep): { ok: boolean; message?: string } {
    return validateProduces(step, this.configManager.getProjectPath() || '', this._runState?.inputs || {});
  }

  /** True when a step runs headless (AI review), so it has no shared UI surface and can run concurrently. */
  private _isHeadlessStep(step: FlowStep): boolean {
    return !!step.review?.required && (step.review.type === 'ai' || !!step.review.reviewers?.some(r => r.type === 'ai'));
  }

  /**
   * Auto-run dependent steps once their dependencies are done (the DAG orchestrator). On a
   * fan-out, every headless/AI branch launches concurrently — they have no shared UI surface.
   * Interactive (human/terminal) steps share one chat box, so only the first launches; the rest
   * are parked with a one-time notice until a terminal slot frees up.
   */
  private _advanceReadySteps(): void {
    if (!this._currentFlow || !this._runState) return;
    this._resetBookkeepingIfNewRun();
    const flow = this._currentFlow;
    const done = machine.doneStepIds(this._runState);
    const ready = pickAutoAdvanceSteps(flow.steps, done, this._startedStepIds)
      .map(id => flow.steps.find(s => s.id === id))
      .filter((s): s is FlowStep => !!s);
    if (!ready.length) return;

    const headless = ready.filter(s => this._isHeadlessStep(s));
    const interactive = ready.filter(s => !this._isHeadlessStep(s));

    for (const step of headless) void this._run(step.id);

    const [first, ...waiting] = interactive;
    if (first) void this._run(first.id);
    for (const step of waiting) {
      if (this._parkedStepIds.has(step.id)) continue;
      this._parkedStepIds.add(step.id);
      this.post({ type: 'stepUpdate', stepId: step.id, append: true, output: '\n[ready — waiting for an interactive slot; click to launch this step when you are ready]\n' });
    }
  }

  private _resetBookkeepingIfNewRun(): void {
    const runId = this._runState?.runId;
    if (runId === this._bookkeepingRunId) return;
    this._bookkeepingRunId = runId;
    this._startedStepIds = this._runState ? seedStartedSteps(this._runState.steps) : new Set<string>();
    this._parkedStepIds = new Set<string>();
  }
}
