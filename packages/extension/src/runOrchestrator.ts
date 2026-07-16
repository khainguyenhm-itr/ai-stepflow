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
  resolveMaxTurns, resolveTimeoutMs, buildHeadlessMcpConfig,
  runOutputSlug, legacyRunOutputSlug,
  StepRunState
} from '@ai-stepflow/core';
import * as machine from '@ai-stepflow/core';
import {
  StepRunContext,
  runInteractiveStep,
  checkStepGuards,
} from './stepRunner.js';

/**
 * How long a step's declared artifacts must stop changing before the shell-integration fallback
 * treats the step as finished. Long enough to outlast a pause between the agent's writes, short
 * enough not to add noticeable latency once it has genuinely stopped.
 */
const ARTIFACT_QUIET_MS = 12_000;

/** Everything a single run needs to advance in isolation from every other concurrent run. */
interface RunCtx {
  flow: Flow;
  runState: FlowRunState;
  /** Steps already launched, so the DAG orchestrator never starts one twice. */
  startedStepIds: Set<string>;
  /** Interactive steps already announced as parked, so the notice isn't repeated each advance. */
  parkedStepIds: Set<string>;
  /** Steps that already consumed their one automatic AI-review retry. */
  autoRetryStepIds: Set<string>;
  /** When each interactive step started, used to locate its Claude session file. */
  stepStartTimes: Map<string, Date>;
  /** Fallback-probe quiescence snapshots per step (last artifact change-signature + when first seen). */
  readinessSnapshots: Map<string, { sig: string; since: number }>;
  /** Skills read from disk once per run and reused by every step. */
  skillsCache: Skill[] | undefined;
  /** Buffered streamed output chunks per step (flushed on the shared 50 ms tick). */
  outputChunkBuffer: Map<string, string>;
  /** Serializes THIS run's own state transitions (independent of other runs' queues). */
  stateUpdateQueue: Promise<void>;
}

/**
 * Owns the run state machine and every transition that drives it: launching a step (headless or
 * interactive), the two-layer review, cancel, mark-done, human review, the DAG auto-advance, plus
 * verify/report. Extracted from {@link CockpitPanel} so the panel is just message routing + view,
 * and so all run logic lives in one cohesive unit. The panel hands it the shared dependencies and
 * a `post` callback to reach the webview; the orchestrator is the authority on `currentFlow` and
 * `runState` — the panel reads them only for restore/cleanup, never mutates them directly.
 */
export class RunOrchestrator {
  /**
   * All live runs, keyed by runId. Each holds its own flow, state, bookkeeping, and update queue,
   * so concurrent runs never clobber one another (the isolation guarantee). The two singleton
   * fields this replaced (`_currentFlow`/`_runState`) are now derived from `_focusedRunId`.
   */
  private _runs = new Map<string, RunCtx>();
  /** The run the webview is currently viewing — backs the currentFlow/runState getters and every
   *  webview-originated action (which always operates on the visible run). */
  private _focusedRunId: string | undefined;
  /** The flow selected in the webview, even when no run is open yet (loadFlow with no runState). */
  private _focusedFlow: Flow | undefined;
  /** The run that currently owns the single interactive terminal. The terminal callbacks carry only
   *  a stepId, so this attributes their events to the right run even after focus moves elsewhere. */
  private _activeInteractiveRunId: string | undefined;
  /** Headless `claude -p` runs (AI-step execution + AI review) in flight, killed on dispose. */
  private _activeRuns = new Set<ChildProcess>();
  /** In-flight headless child per `${runId}::${stepId}`, so a "Cancel" can kill exactly that run. */
  private _runChildrenByStep = new Map<string, ChildProcess>();
  /** In-flight AI-generation children (agent/skill/flow drafts), so a cancel can kill exactly those. */
  private _generationRuns = new Set<ChildProcess>();
  /** `${runId}::${stepId}` the user cancelled, so the resolving run handler skips its own failure transition. */
  private _cancelledStepIds = new Set<string>();
  /** Single 50 ms flush timer shared across every run's output buffer. */
  private _outputFlushTimer: ReturnType<typeof setTimeout> | undefined;

  /** Composite key so process-global maps never confuse two runs that share a stepId (e.g. "step-1"). */
  private _rk(runId: string, stepId: string): string { return `${runId}::${stepId}`; }

  /** Tag a step/review output message with its owning runId so the webview can route it per run. */
  private _withRun(runId: string | undefined, msg: HostMessage): HostMessage {
    if (runId && (msg.type === 'stepUpdate' || msg.type === 'aiReviewUpdate') && msg.runId === undefined) {
      return { ...msg, runId };
    }
    return msg;
  }

  /** The focused run's context, or undefined when no run is open. */
  private _focused(): RunCtx | undefined {
    return this._focusedRunId ? this._runs.get(this._focusedRunId) : undefined;
  }

  /** Build a fresh RunCtx with clean per-run bookkeeping (bookkeeping is born with the run). */
  private _newRunCtx(flow: Flow, runState: FlowRunState): RunCtx {
    return {
      flow,
      runState,
      startedStepIds: machine.seedStartedSteps(runState.steps),
      parkedStepIds: new Set<string>(),
      autoRetryStepIds: new Set<string>(),
      stepStartTimes: new Map<string, Date>(),
      readinessSnapshots: new Map<string, { sig: string; since: number }>(),
      skillsCache: undefined,
      outputChunkBuffer: new Map<string, string>(),
      stateUpdateQueue: Promise.resolve(),
    };
  }

  constructor(
    private readonly configManager: ConfigManager,
    private readonly stateManager: StateManager,
    private readonly terminals: TerminalManager,
    private readonly post: (message: HostMessage) => void
  ) {
    this.terminals.onDidCloseRunningStep(async stepId => {
      // Attribute the terminal event to the run that OWNS the terminal, not whatever run is focused.
      const runId = this._activeInteractiveRunId;
      const rc = runId ? this._runs.get(runId) : undefined;
      if (rc && rc.runState.steps[stepId]?.executionStatus === 'running') {
        await this._setRunState(runId!, machine.markCancelled(rc.runState, rc.flow, stepId), { stepId, status: 'cancelled', message: 'Terminal closed by user' });
        this.post(this._withRun(runId!, { type: 'stepUpdate', stepId, append: true, output: '\n[terminal closed — run cancelled]\n' }));
      }
      this._activeInteractiveRunId = undefined;
    });
    // Fallback readiness probe (shell integration unavailable): report whether the step's declared
    // artifacts are done being written, so the fallback reviews the real output instead of firing
    // on a guessed timeout. `undefined` means the step declares no artifact to wait on. Existence +
    // freshness is not enough — a file created early and appended to for minutes stays "fresh" the
    // whole time — so we require the change-signature (newest mtime + total size) to hold steady for
    // ARTIFACT_QUIET_MS, i.e. the agent has stopped writing.
    this.terminals.onCheckStepReady(stepId => {
      const runId = this._activeInteractiveRunId;
      const rc = runId ? this._runs.get(runId) : undefined;
      if (!rc) return undefined;
      const { flow, runState } = rc;
      const step = flow.steps.find(s => s.id === stepId);
      if (!step) return undefined;
      const hasArtifactSpec = (step.produces?.length ?? 0) > 0 || !!step.review.filePath;
      if (!hasArtifactSpec) return undefined;
      const projectPath = this.configManager.getProjectPath() || '';
      const inputs = runState.inputs || {};
      const stale = machine.findStaleProducedFile(step, projectPath, inputs, runState.steps[stepId]?.startedAt, flow.name, this._runSlug(runId!), this._legacyRunSlug(runId!));
      const artifactSig = stale ? null : machine.producedArtifactsSignature(step, projectPath, inputs, flow.name, this._runSlug(runId!), this._legacyRunSlug(runId!));
      if (!artifactSig) { rc.readinessSnapshots.delete(stepId); return false; } // missing or stale → keep waiting
      // Fold the session transcript's change-signature into the quiescence check. The declared
      // artifact can go quiet early (written up front) while the agent keeps working — writing
      // OTHER files, running tests, iterating — so an artifact-only quiet window fires the review
      // before the terminal has actually finished. The `<sessionId>.jsonl` transcript is appended
      // on every message/tool-call, so it reflects ALL the agent's activity: the step is done only
      // once BOTH the artifact and the transcript have held steady for ARTIFACT_QUIET_MS.
      const sig = `${artifactSig}|${this._sessionTranscriptSignature(runId!, stepId)}`;
      const prev = rc.readinessSnapshots.get(stepId);
      const now = Date.now();
      if (!prev || prev.sig !== sig) { rc.readinessSnapshots.set(stepId, { sig, since: now }); return false; }
      return now - prev.since >= ARTIFACT_QUIET_MS;
    });
    this.terminals.onDidEndRunningStep(async stepId => {
      const runId = this._activeInteractiveRunId;
      const rc = runId ? this._runs.get(runId) : undefined;
      if (!rc) return;
      if (rc.runState.steps[stepId]?.executionStatus !== 'running') return;
      const step = rc.flow.steps.find(s => s.id === stepId);
      if (!step) return;
      const metrics = await this._readInteractiveMetrics(runId!, stepId);
      // Every step is reviewed: mark completed then run the review (AI reviews auto-decide,
      // human reviews wait for approval).
      await this._setRunState(runId!, s => machine.markCompleted(s, rc.flow, stepId, metrics), { stepId, status: 'completed', message: 'Terminal session ended — reviewing' });
      this._activeInteractiveRunId = undefined; // terminal freed for the next interactive step
      await this._reviewStep(runId!, step, stepId);
    });
  }

  get currentFlow(): Flow | undefined { return this._focused()?.flow ?? this._focusedFlow; }
  get runState(): FlowRunState | undefined { return this._focused()?.runState; }

  /** Upsert a run into the map and focus it (loadFlow / switchRun / openRun). No transition, no broadcast. */
  setFlowAndRunState(flow: Flow | undefined, runState: FlowRunState | undefined): void {
    this._focusedFlow = flow;
    if (flow && runState) {
      const existing = this._runs.get(runState.runId);
      if (existing) { existing.flow = flow; existing.runState = runState; }
      else this._runs.set(runState.runId, this._newRunCtx(flow, runState));
      this._focusedRunId = runState.runId;
    } else {
      // Selecting a flow with no run open: keep other runs live, just clear the focused run.
      this._focusedRunId = undefined;
    }
  }

  /** Forget every run of `flowId` if that flow is being deleted. */
  clearIfFlow(flowId: string): void {
    for (const [rid, rc] of this._runs) if (rc.flow.id === flowId) this._runs.delete(rid);
    if (this._focusedFlow?.id === flowId) { this._focusedFlow = undefined; this._focusedRunId = undefined; }
  }

  /**
   * Persist a run state the webview pushed (updateRunState) without re-broadcasting it — the
   * webview already has it. Used for display-only mirror updates that aren't a transition.
   */
  async adoptRunState(runState: FlowRunState, historyEvent?: HistoryEvent): Promise<void> {
    const existing = this._runs.get(runState.runId);
    if (existing) existing.runState = runState;
    else if (this._focusedFlow) this._runs.set(runState.runId, this._newRunCtx(this._focusedFlow, runState));
    this._focusedRunId = runState.runId;
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
    const focused = this._focused();
    let runState = focused?.runState;
    let flow = focused?.flow;
    if (!runState) {
      runState = await this.stateManager.loadLatestRun();
      if (!runState) return;
      const flows = await this.configManager.loadFlows();
      flow = flows.find(f => f.id === runState!.flowId);
    }
    if (!flow || !runState) return;
    const existing = this._runs.get(runState.runId);
    if (existing) { existing.flow = flow; existing.runState = runState; }
    else this._runs.set(runState.runId, this._newRunCtx(flow, runState));
    this._focusedFlow = flow;
    this._focusedRunId = runState.runId;
    this.post({ type: 'restoreRun', flow, runState });
  }

  /**
   * Entry point from the webview's "Run step". Seeds the backend's authoritative state for a NEW
   * run — the webview owns flow selection and the initial run state, but the backend takes ownership
   * of every transition from here on so a stale webview copy can never roll back a transition.
   * Mid-run, the backend's own RunCtx state wins (the webview's copy is not adopted).
   */
  async runStep(stepId: string, opts: { flow?: Flow; runState?: FlowRunState; description?: string; runId?: string } = {}): Promise<void> {
    if (opts.flow) this._focusedFlow = opts.flow;
    const rs = opts.runState;
    if (rs) {
      let rc = this._runs.get(rs.runId);
      if (!rc) {
        const flow = opts.flow ?? this._focusedFlow;
        if (!flow) return;
        rc = this._newRunCtx(flow, rs);
        this._runs.set(rs.runId, rc);
      } else if (opts.flow) {
        rc.flow = opts.flow;
      }
      this._focusedRunId = rs.runId;
      await this._run(rs.runId, stepId, opts.description);
      return;
    }
    // Mid-run re-run without a resent runState: act on the explicitly targeted run, else the focused one.
    const runId = opts.runId ?? this._focusedRunId;
    if (runId && this._runs.has(runId)) {
      const rc = this._runs.get(runId)!;
      if (opts.flow) rc.flow = opts.flow;
      await this._run(runId, stepId, opts.description);
    }
  }

  private async _run(runId: string, stepId: string, description?: string): Promise<void> {
    const rc = this._runs.get(runId);
    if (!rc) return;
    const { flow } = rc;
    const step = flow.steps.find(s => s.id === stepId);
    if (!step) return;

    const cleared = await checkStepGuards(
      stepId, step, flow, rc.runState,
      (next, audit) => this._setRunState(runId, next, audit),
      msg => this.post(msg),
      step => this._validateRequires(runId, step)
    );
    if (!cleared) return;

    const agents = await this.configManager.loadAgents();
    const agent = agents.find(a => a.name === step.agent);
    const stepSkillNames = step.skills && step.skills.length ? step.skills : (step.skill ? [step.skill] : []);
    // A skill is optional (the UI no longer forces one, and composeInteractiveMessage falls back to
    // the plain description when there is none). Only a valid agent is required to run the step.
    if (!agent) {
      this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: `\n[cannot run — agent '${step.agent || '(none)'}' not found]\n` }));
      vscode.window.showErrorMessage(`Step '${step.title || step.id}' cannot run: agent '${step.agent || '(none)'}' not found.`);
      return;
    }

    rc.startedStepIds.add(stepId);
    const projectPath = this.configManager.getProjectPath() || '';

    // Build the shared context object injected into runner functions. Every closure is pinned to
    // THIS runId, so an async callback for this step always resolves against its own run — never
    // whatever run happens to be focused when the callback fires.
    const ctx: StepRunContext = {
      flow,
      runState: rc.runState,
      step,
      stepId,
      agent,
      stepSkillNames,
      skills: await this._getSkillsForRun(runId),
      projectPath,
      description,
      spawnClaudeStreaming: (opts, sid) => this._spawnClaudeStreaming(opts, sid ? this._rk(runId, sid) : undefined),
      bufferOutput: (sid, chunk) => this._bufferOutput(runId, sid, chunk),
      flushOutputBuffer: () => this._flushOutputBuffer(),
      setRunState: (next, audit) => this._setRunState(runId, next, audit),
      patchStepState: (sid, patch) => this._patchStepState(runId, sid, patch),
      consumeCancelledStep: sid => this._cancelledStepIds.delete(this._rk(runId, sid)),
      post: msg => this.post(this._withRun(runId, msg)),
      advanceReadySteps: () => this._advanceReadySteps(runId),
      runAiReview: (s, sid, pp) => this._runAiReview(runId, s, sid, pp),
      validateProduces: s => this._validateProduces(runId, s),
      runMaxTurns: a => this._runMaxTurns(a),
      setStepStartTime: (sid, t) => rc.stepStartTimes.set(sid, t),
    };

    // This run now owns the single interactive terminal (used by the terminal callbacks to
    // attribute their stepId-only events back to this run).
    this._activeInteractiveRunId = runId;
    // All steps run in the interactive terminal and auto-submit (like an agent/skill run) so
    // pressing "Run Step" actually executes; AI-reviewed steps are auto-verified in
    // onDidEndRunningStep.
    await runInteractiveStep(ctx, this.terminals, true);
  }

  /** Approve/reject a step from the webview's human-review buttons (targets `explicitRunId`, else the focused run). */
  async reviewStep(stepId: string, decision: 'approved' | 'rejected', explicitRunId?: string): Promise<void> {
    const runId = explicitRunId ?? this._focusedRunId;
    const rc = runId ? this._runs.get(runId) : undefined;
    if (!runId || !rc) return;
    const flow = rc.flow;
    const step = flow.steps.find(s => s.id === stepId);
    const isRunning = rc.runState.steps[stepId]?.executionStatus === 'running';

    if (decision === 'approved') {
      if (step) {
        const prod = this._validateProduces(runId, step);
        if (!prod.ok) {
          const msg = `produces check failed: ${prod.message}`;
          this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: `\n[cannot approve — ${msg}]\n` }));
          vscode.window.showErrorMessage(`Cannot approve '${step.title || step.id}': ${prod.message}`);
          return;
        }
        const content = await this._verifyProducesContent(runId, step);
        if (!content.ok) {
          this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: `\n[cannot approve — ${content.message}]\n` }));
          vscode.window.showErrorMessage(`Cannot approve '${step.title || step.id}': ${content.message}`);
          return;
        }
      }

      if (isRunning) {
        // Terminal still running: mark done first (so close-terminal handler is a no-op), then close.
        const metrics = await this._readInteractiveMetrics(runId, stepId);
        await this._setRunState(runId, s => machine.markDone(machine.applyHumanReview(machine.markCompleted(s, flow, stepId, metrics), flow, stepId, { decision: 'approved' }), flow, stepId), { stepId, status: 'completed', message: 'Approved by user' });
        this.terminals.cancelStep(stepId);
        // Human review does not produce a report file (only AI review does).
        this._advanceReadySteps(runId);
        return;
      }
    }

    if (decision === 'rejected' && isRunning) {
      // Terminal still running: mark completed then apply rejection so state is 'ready' before
      // closing terminal (prevents onDidCloseRunningStep from overwriting with 'cancelled').
      const metrics = await this._readInteractiveMetrics(runId, stepId);
      await this._setRunState(runId, s => machine.applyHumanReview(machine.markCompleted(s, flow, stepId, metrics), flow, stepId, { decision: 'rejected' }), { stepId, status: 'rejected', message: 'Rejected by user' });
      this.terminals.cancelStep(stepId);
      // Human review does not produce a report file (only AI review does).
      return;
    }

    // Terminal already ended: apply review decision to the completed step.
    await this._persistInteractiveMetrics(runId, stepId);
    const review = { decision };
    await this._setRunState(runId, s => machine.applyHumanReview(s, flow, stepId, review), { stepId, status: decision, message: `Human review ${decision}` });
    // Human review does not produce a report file (only AI review does).

    if (decision === 'approved' && rc.runState.steps[stepId]?.completionStatus === 'done') {
      this._advanceReadySteps(runId);
    }
  }

  /**
   * Toggle auto-pilot for the current run (persisted on the run state). Locked once the run has
   * begun — a step running under one policy can't have the policy flipped mid-flight — so it can
   * only be changed while every step is still pristine (no history). Reset the run to change it.
   */
  async setAutoReview(enabled: boolean, explicitRunId?: string): Promise<void> {
    const runId = explicitRunId ?? this._focusedRunId;
    const rc = runId ? this._runs.get(runId) : undefined;
    if (!runId || !rc || rc.runState.autoReview === enabled) return;
    const anyStepStarted = Object.values(rc.runState.steps).some(
      s => (s.history?.length ?? 0) > 0 || (s.executionStatus !== 'ready' && s.executionStatus !== 'locked')
    );
    if (anyStepStarted) return;
    await this._setRunState(runId, s => ({ ...s, autoReview: enabled }));
    if (enabled) this._advanceReadySteps(runId);
  }

  /**
   * Edit the current run's human-facing name and inputs (the same fields set when creating a run).
   * Locked once any step has started — `runName` drives the per-run output slug and `inputs` drive
   * produces/requires path + prompt resolution, so changing them after artifacts exist would orphan
   * or desync them. Same pristine guard as {@link setAutoReview}. Reuses the reset remap path
   * (`previousRunId` = current runId) so the run summary row's displayed name updates in place.
   */
  async editRunMeta(runName: string | undefined, inputs: Record<string, string>, explicitRunId?: string): Promise<void> {
    const runId = explicitRunId ?? this._focusedRunId;
    const rc = runId ? this._runs.get(runId) : undefined;
    if (!runId || !rc) return;
    const anyStepStarted = Object.values(rc.runState.steps).some(
      s => (s.history?.length ?? 0) > 0 || (s.executionStatus !== 'ready' && s.executionStatus !== 'locked')
    );
    if (anyStepStarted) return;
    const name = runName?.trim() || undefined;
    await this._setRunState(runId, s => ({ ...s, runName: name, inputs }));
    this.post({ type: 'restoreRun', flow: rc.flow, runState: rc.runState, previousRunId: runId });
  }

  /**
   * Finalize a step whose "Mark step done" was pressed. Gates requires/produces, then either
   * completes (no review needed, or already approved) and advances the DAG, or opens the review gate.
   */
  /** Kill (and mark cancelled) only the headless step children belonging to `runId`. */
  private _killRunChildren(runId: string): void {
    const prefix = `${runId}::`;
    for (const [key, child] of this._runChildrenByStep) {
      if (key.startsWith(prefix)) { this._cancelledStepIds.add(key); child.kill(); }
    }
  }

  /** Drop a dead run's `${runId}::*` entries from the global cancelled set. */
  private _purgeRunKeys(runId: string): void {
    const prefix = `${runId}::`;
    for (const key of [...this._cancelledStepIds]) if (key.startsWith(prefix)) this._cancelledStepIds.delete(key);
  }

  /** Reset a run (targets `explicitRunId`, else the focused run) to a fresh state, terminating its in-flight processes. */
  async resetRun(explicitRunId?: string): Promise<void> {
    const oldRunId = explicitRunId ?? this._focusedRunId;
    const rc = oldRunId ? this._runs.get(oldRunId) : undefined;
    if (!oldRunId || !rc) return;
    const flow = rc.flow;
    const oldSteps = rc.runState.steps;
    const oldRunState = rc.runState;

    // Capture this run's artifacts BEFORE the state swap (reset mints a new runId → new slug).
    const projectPath = this.configManager.getProjectPath() || '';
    const runArtifacts = this._producedFilePaths(oldRunId, flow.steps.map(s => s.id));
    const runOutputDir = machine.flowOutputDir(flow.name, projectPath, this._runSlug(oldRunId));

    // Only this run's headless children — a concurrent run's work is left untouched.
    this._killRunChildren(oldRunId);

    // Each run owns its artifacts; reset discards them so a re-run starts from a clean slate.
    const deleted = this._deleteFiles(runArtifacts);
    this._deleteRunOutputDir(runOutputDir);
    vscode.window.showInformationMessage(`AI StepFlow: run reset — cleared this run's artifacts${deleted.length ? ` (${deleted.length} file${deleted.length === 1 ? '' : 's'})` : ''}.`);

    const freshState = machine.initRunState(flow, {
      runId: new Date().toISOString(),
      // Reset re-runs the SAME run from a clean slate, so keep its human-facing name and inputs.
      // Dropping runName made the run fall back to the timestamp runId for its display/output slug.
      runName: oldRunState.runName,
      projectPath: oldRunState.projectPath,
      inputs: oldRunState.inputs,
    });
    await Promise.all([
      this.stateManager.clearAuditLog(flow.id, oldRunId),
      this.stateManager.deleteRunFile(oldRunState),
      this.stateManager.deleteReportFile(oldRunState),
      this.stateManager.deleteReviewReports(oldRunState, flow.steps.map(s => s.id)),
    ]);
    this.post({ type: 'resetAuditLog', flowId: flow.id, runId: oldRunId });

    // Move the run to its fresh runId with clean bookkeeping before broadcasting.
    this._runs.delete(oldRunId);
    this._purgeRunKeys(oldRunId);
    if (this._activeInteractiveRunId === oldRunId) this._activeInteractiveRunId = undefined;
    this._runs.set(freshState.runId, this._newRunCtx(flow, freshState));
    if (this._focusedRunId === oldRunId) this._focusedRunId = freshState.runId;
    await this._setRunState(freshState.runId, freshState);
    // Carry the old runId so the webview can remap this run's summary row to the new runId — reset
    // mints a fresh runId, and without the remap the row keeps pointing at the deleted run file and
    // its detail drawer can't reopen.
    this.post({ type: 'restoreRun', flow, runState: freshState, previousRunId: oldRunId });

    // Dispose any running terminal only after freshState is in place.
    for (const [stepId, state] of Object.entries(oldSteps)) {
      if (state.executionStatus === 'running') this.terminals.cancelStep(stepId);
    }
  }

  /** Clear a run (targets `explicitRunId`, else the focused run) from the cockpit view. */
  async closeRun(finalize?: boolean, explicitRunId?: string): Promise<void> {
    const runId = explicitRunId ?? this._focusedRunId;
    const rc = runId ? this._runs.get(runId) : undefined;
    const flowId = rc?.flow.id;
    if (rc && runId) {
      if (finalize) {
        // When finalizing, mark the whole flow closed.
        rc.runState = { ...rc.runState, isClosed: true };
      }
      await this.stateManager.saveRun(rc.runState);
      this._runs.delete(runId);
      this._purgeRunKeys(runId);
      if (this._activeInteractiveRunId === runId) this._activeInteractiveRunId = undefined;
    }
    // Only drop focus when the closed run WAS the focused one — closing a background run leaves the view.
    if (runId && this._focusedRunId === runId) {
      this._focusedRunId = undefined;
      this._focusedFlow = undefined;
    }
    this.post({ type: 'runClosed', flowId, runId, finalized: !!finalize });
  }

  /** Delete a run (targets `explicitRunId`, else the focused run): terminate its processes, remove the file, notify the webview. */
  async deleteRun(explicitRunId?: string): Promise<void> {
    const runId = explicitRunId ?? this._focusedRunId;
    const rc = runId ? this._runs.get(runId) : undefined;
    if (!runId || !rc) return;
    const flow = rc.flow;

    this._killRunChildren(runId);

    await Promise.all([
      this.stateManager.clearAuditLog(flow.id, runId),
      this.stateManager.deleteRunFile(rc.runState),
      this.stateManager.deleteReportFile(rc.runState),
      this.stateManager.deleteReviewReports(rc.runState, flow.steps.map(s => s.id)),
    ]);

    this._runs.delete(runId);
    this._purgeRunKeys(runId);
    if (this._activeInteractiveRunId === runId) this._activeInteractiveRunId = undefined;
    if (this._focusedRunId === runId) {
      this._focusedRunId = undefined;
      this._focusedFlow = undefined;
    }

    this.post({ type: 'runDeleted', flowId: flow.id, runId });
  }

  async verify(): Promise<void> {
    const rc = this._focused();
    if (!rc) return;
    const projectPath = this.configManager.getProjectPath();
    if (!projectPath) return;

    const report = verifyRun(rc.flow, rc.runState, projectPath);
    if (report.ok) {
      vscode.window.showInformationMessage(`AI StepFlow: verify passed for run '${rc.runState.runId}'.`);
      return;
    }

    const markdown = renderVerifyReportMarkdown(rc.flow, rc.runState, report);
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showWarningMessage(`AI StepFlow: verify found drift in ${report.drift.length} step(s).`);
  }

  async exportReport(): Promise<void> {
    const rc = this._focused();
    if (!rc) return;
    const auditLog = await this.stateManager.loadAuditLog(rc.flow.id);
    const markdown = renderRunReport(rc.flow, rc.runState, auditLog);
    const filePath = await this.stateManager.saveReport(rc.runState, markdown);
    if (!filePath) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
    const base = filePath.split(/[\\/]/).pop();
    vscode.window.showInformationMessage(`AI StepFlow: run report exported to ${base}.`);
  }

  /** Terminate a step's running process (headless or terminal) and record it as cancelled (targets `explicitRunId`, else focused). */
  async cancelStep(stepId: string, explicitRunId?: string): Promise<void> {
    const runId = explicitRunId ?? this._focusedRunId;
    const rc = runId ? this._runs.get(runId) : undefined;
    const key = runId ? this._rk(runId, stepId) : '';
    const child = key ? this._runChildrenByStep.get(key) : undefined;
    if (child && runId && rc) {
      // Headless run — kill the tracked child process directly
      this._cancelledStepIds.add(key);
      child.kill();
      this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: '\n[run cancelled by user]\n' }));
      await this._setRunState(runId, machine.markCancelled(rc.runState, rc.flow, stepId), { stepId, status: 'cancelled', message: 'Cancelled by user' });
      return;
    }
    // Terminal (interactive) run — flip the state to cancelled BEFORE disposing the terminal, so
    // the close/end handlers see a non-'running' step and become no-ops. We can't rely on
    // onDidCloseRunningStep to set the state: TerminalManager.cancelStep clears its _terminal ref
    // synchronously, so the later onDidCloseTerminal identity check fails and the callback never
    // fires — which would leave the step wedged at "running" (Stop button appears to do nothing).
    if (key) this._cancelledStepIds.add(key);
    if (rc && runId && rc.runState.steps[stepId]?.executionStatus === 'running') {
      await this._setRunState(runId, machine.markCancelled(rc.runState, rc.flow, stepId), { stepId, status: 'cancelled', message: 'Cancelled by user' });
      if (this._activeInteractiveRunId === runId) this._activeInteractiveRunId = undefined;
    }
    this.terminals.cancelStep(stepId);
    this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: '\n[run cancelled by user]\n' }));
  }

  /**
   * Reset a single wedged step (and everything downstream) to its fresh initial state so it can be
   * re-run. Terminates any in-flight process/terminal for that step, drops its audit-log entries,
   * then broadcasts the fresh state.
   */
  async resetStep(stepId: string, explicitRunId?: string): Promise<void> {
    const runId = explicitRunId ?? this._focusedRunId;
    const rc = runId ? this._runs.get(runId) : undefined;
    if (!runId || !rc) return;
    const flow = rc.flow;
    const ids = [stepId, ...machine.dependentStepIds(flow, stepId)];

    // Kill any in-flight run for the affected steps before the state flips, so their completion
    // handlers become no-ops.
    for (const id of ids) {
      const key = this._rk(runId, id);
      this._cancelledStepIds.add(key);
      const child = this._runChildrenByStep.get(key);
      if (child) child.kill();
      this.terminals.cancelStep(id);
    }
    // The terminal was just cancelled for one of this run's steps — release ownership.
    if (this._activeInteractiveRunId === runId) this._activeInteractiveRunId = undefined;

    // Delete the artifacts this step (and its now-reset dependents) produced, so the re-run
    // regenerates them instead of an AI review reading a stale file from the previous attempt.
    const deleted = this._deleteFiles(this._producedFilePaths(runId, ids));

    // Also drop any AI review reports these steps left behind when rejected, so a re-run doesn't
    // carry stale verdicts. runName/runId are unchanged by resetStep, so the run slug still matches.
    await this.stateManager.deleteReviewReports(rc.runState, ids);

    await this.stateManager.clearAuditLog(flow.id, runId, ids);
    this.post({ type: 'resetAuditLog', flowId: flow.id, runId, stepIds: ids });
    await this._setRunState(runId, s => machine.resetStep(s, flow, stepId));
    this.post({ type: 'restoreRun', flow, runState: rc.runState });
    if (deleted.length) {
      this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: `\n[reset — deleted ${deleted.length} produced file${deleted.length === 1 ? '' : 's'}]\n` }));
    }
    // Clear stale cancelled IDs so the re-run is not silently skipped.
    for (const id of ids) this._cancelledStepIds.delete(this._rk(runId, id));
  }

  /**
   * Run `claude` headless with stream-json output. The child process is tracked in `_activeRuns`
   * (killed on dispose) and, when a `stepId` is provided, in `_runChildrenByStep` so the user's
   * "Cancel" can kill exactly that run. A per-run timeout config bounds a hung run. Public so the
   * cockpit can reuse it for ad-hoc drafts and get the same timeout + dispose cleanup.
   */
  spawnClaudeStreaming(opts: ClaudeStreamingRunOptions, stepId?: string): Promise<ClaudeStreamingRunResult> {
    return this._spawnClaudeStreaming(opts, stepId, true);
  }

  /** Kill every in-flight AI-generation child so a closed generate modal leaves nothing running. */
  cancelGeneration(): void {
    for (const child of this._generationRuns) child.kill();
    this._generationRuns.clear();
  }

  /**
   * Resolve a step's declared `requires`/`produces` entry (a plain filename, workspace-relative
   * path, or absolute path) to where the artifact actually lives for the CURRENT run — applying
   * input templating and the same nested-file lookup the runner uses. A plain filename resolves
   * under `.ai-stepflow/output/{flow}/{run}/`, not the project root. Returns undefined when there
   * is no active run to scope the lookup.
   */
  resolveArtifactPath(declared: string): string | undefined {
    const runId = this._focusedRunId;
    const rc = this._focused();
    if (!runId || !rc) return undefined;
    const projectPath = this.configManager.getProjectPath() || '';
    const [resolved] = machine.resolveTemplates([declared], rc.runState.inputs || {});
    return machine.locateProducedFile(resolved, rc.flow.name, projectPath, this._runSlug(runId), this._legacyRunSlug(runId));
  }

  /** Terminate every in-flight headless run. The cockpit owns terminal/panel cleanup. */
  dispose(): void {
    for (const child of this._activeRuns) child.kill();
  }

  // --- internals -----------------------------------------------------------

  /**
   * Absolute paths of every file the given steps declare in `produces`, resolved for the CURRENT
   * run (flow name + run slug + inputs). Used to delete a run's/step's artifacts on reset.
   */
  private _producedFilePaths(runId: string, stepIds: string[]): string[] {
    const rc = this._runs.get(runId);
    if (!rc) return [];
    const flow = rc.flow;
    const projectPath = this.configManager.getProjectPath() || '';
    const inputs = rc.runState.inputs || {};
    const slug = this._runSlug(runId);
    const legacySlug = this._legacyRunSlug(runId);
    const paths = new Set<string>();
    for (const id of stepIds) {
      const step = flow.steps.find(s => s.id === id);
      if (!step) continue;
      for (const p of machine.resolveTemplates(step.produces, inputs)) {
        // Locate where the artifact actually is (an agent may have nested it), so a per-step
        // reset deletes the real file, not just the exact declared path.
        paths.add(machine.locateProducedFile(p, flow.name, projectPath, slug, legacySlug));
      }
    }
    return [...paths];
  }

  /** Delete the given files, but only those inside the workspace (never touch external paths). Returns the ones removed. */
  private _deleteFiles(paths: string[]): string[] {
    const root = this.configManager.getProjectPath() || '';
    const deleted: string[] = [];
    for (const p of paths) {
      try {
        const rel = root ? path.relative(root, p) : '..';
        if (!root || rel.startsWith('..') || path.isAbsolute(rel)) continue; // outside workspace — skip
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          fs.unlinkSync(p);
          deleted.push(p);
        }
      } catch { /* ignore individual delete failures */ }
    }
    return deleted;
  }

  /** Remove a run's dedicated output folder (recursive), guarded to stay under `.ai-stepflow/output`. */
  private _deleteRunOutputDir(dir: string): void {
    try {
      if (fs.existsSync(dir) && dir.includes(path.join('.ai-stepflow', 'output'))) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }

  /**
   * Commit a new authoritative run state: persist it and broadcast it to the webview, which
   * renders it without computing its own transitions. Optionally records an audit event.
   * All updates are queued to guarantee atomicity and prevent race conditions across concurrent runs.
   */
  private _setRunState(runId: string, next: FlowRunState | ((prev: FlowRunState) => FlowRunState), audit?: { stepId: string; status: string; message?: string }): Promise<void> {
    const rc = this._runs.get(runId);
    if (!rc) return Promise.resolve();
    const promise = rc.stateUpdateQueue.then(async () => {
      // Re-fetch: the run may have been deleted while this transition was queued.
      const live = this._runs.get(runId);
      if (!live) return;
      // Resolve against the run's OWN state (never a shared/focused field), so a focus switch
      // between enqueue and drain can't make this transition read or overwrite another run.
      const resolvedNext = typeof next === 'function' ? next(live.runState) : next;
      live.runState = resolvedNext;
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
    rc.stateUpdateQueue = promise;
    return promise;
  }

  /**
   * Update a run's authoritative state with a partial patch for one step, e.g. to accumulate
   * incremental output during a run without triggering a full state transition.
   */
  private async _patchStepState(runId: string, stepId: string, patch: Partial<StepRunState>): Promise<void> {
    await this._setRunState(runId, s => {
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
  private async _reviewStep(runId: string, step: FlowStep, stepId: string): Promise<void> {
    const rc = this._runs.get(runId);
    if (!rc) return;
    const flow = rc.flow;
    const projectPath = this.configManager.getProjectPath() || '';
    const isAutoStep = step.review.type === 'ai' || !!step.review.reviewers?.some(r => r.type === 'ai');

    // Auto-review (AI/validator/skill) runs only when the run's auto-review is on. With it off, an
    // auto-review step does NOT call AI review, open a terminal, or run a skill review — it just
    // waits for the user to click "Finish" (markCompleted already parked it at 'waiting_human').
    if (isAutoStep) {
      if (rc.runState.autoReview) {
        await this._runAiReview(runId, step, stepId, projectPath);
      } else {
        this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: `\n[auto review off — click "Finish Step" to continue]\n` }));
      }
      return;
    }
    if (step.review.validatorPath) {
      const verdict = await runValidator({ workspaceRoot: projectPath, step, runState: rc.runState, stepOutput: '' });
      const status: 'approved' | 'rejected' = verdict.decision === 'pass' ? 'approved' : 'rejected';
      const note = `Validator review: ${status} — ${verdict.reason}`;
      await this._setRunState(runId, machine.applyAiReview(rc.runState, flow, stepId, status, note + '\n'), { stepId, status, message: `Validator review ${status}` });
      this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: `\n[${note}]\n` }));
      if (status === 'approved') this._advanceReadySteps(runId);
      return;
    }
    // Human-only review: wait for a decision via the approve/reject buttons. markCompleted
    // already set reviewStatus to 'pending', so the approve/reject UI is shown for this step.
    this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: `\n[review required — approve or reject this step to continue]\n` }));
  }

  /**
   * Two-layer auto-review of a step's produced artifacts:
   *   1) a deterministic validator (.mjs) — cheap, certain (exists / non-empty / no TODO);
   *   2) an LLM reviewer that reads the artifacts against the adaptive default review kit.
   * A pass auto-marks the step done and advances; a rejection sends it back to ready. The validator
   * runs first so an obviously-incomplete artifact is rejected without spending review tokens.
   */
  private async _runAiReview(runId: string, step: FlowStep, stepId: string, projectPath: string): Promise<void> {
    const rc = this._runs.get(runId);
    if (!rc) return;
    const flow = rc.flow;

    const deep = step.review.deep !== false;
    const reviewer = step.review.reviewers?.find(r => r.type === 'ai');
    const reviewerAgent = reviewer?.agent ? (await this.configManager.loadAgents()).find(a => a.name === reviewer.agent) : undefined;

    // Read the review kit + artifacts first so we only flip to the transient "review running"
    // state when an actual LLM call is going to happen. The active kit is picked in the sidebar
    // (Project Settings → Review Kit); an empty/unset pref falls back to the bundled default.
    const activeKit = deep
      ? (step.review.reviewKit || (await this.configManager.loadUiPrefs().catch(() => ({} as Record<string, string>)))['review:activeKit'])
      : '';
    const reviewKit = deep ? machine.loadReviewKit(projectPath, activeKit || undefined) : '';
    const artifacts = deep ? machine.readProducedArtifacts(step, projectPath, rc.runState.inputs || {}, flow.name, this._runSlug(runId), this._legacyRunSlug(runId)) : { text: '', count: 0 };
    if (deep && reviewKit && artifacts.count > 0) {
      await this._setRunState(runId, s => machine.applyAiReview(s, flow, stepId, 'ai_review_running', ''));
    }

    let reviewOut = '';
    const result = await machine.reviewStepArtifacts({
      workspaceRoot: projectPath,
      step,
      runState: rc.runState,
      deep,
      reviewKit,
      artifacts,
      reviewModel: reviewerAgent?.model,
      runner: opts => this._spawnClaudeStreaming({ ...opts, maxTurns: 1 }),
      onText: chunk => { reviewOut += chunk; this.post(this._withRun(runId, { type: 'aiReviewUpdate', stepId, append: true, output: chunk })); }
    });

    const detail = (reviewOut ? `${reviewOut}\n` : '') + `Review (${result.source}): ${result.status} — ${result.note}\n`;
    const reviewMetrics = (result.reviewTokensUsed != null || result.reviewCostUsd != null)
      ? { tokensUsed: result.reviewTokensUsed, costUsd: result.reviewCostUsd }
      : undefined;

    // Auto-review must NEVER silently pass a step it could not actually review — e.g. the step
    // produced no artifact to read, or the review kit/validator isn't installed ('waiting_human').
    // Instead of auto-confirming, halt at a human gate and warn the user so they can inspect and
    // approve/reject deliberately.
    if (result.status === 'waiting_human') {
      const warn = `Auto review could not verify "${step.title || step.id}": ${result.note} Approve or reject it manually.`;
      await this._setRunState(runId, s => machine.applyAiReview(s, flow, stepId, 'waiting_human', `⚠ ${warn}\n`), { stepId, status: 'waiting_human', message: warn });
      this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: `\n[⚠ ${warn}]\n` }));
      vscode.window.showWarningMessage(`AI StepFlow: ${warn}`);
      return;
    }

    await this._setRunState(runId, s => machine.applyAiReview(s, flow, stepId, result.status, detail, reviewMetrics), { stepId, status: result.status, message: `Review ${result.status}` });
    this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: `\n[review (${result.source}): ${result.status} — ${result.note}]\n` }));

    if (result.status === 'approved') {
      // Write an approval report so the step's Files tab shows the review that passed it.
      await this._writeReviewReport(runId, step, stepId, { verdict: 'approved', source: result.source, reason: result.note, correct: result.correct, issues: result.issues, suggestions: result.suggestions });
      this._advanceReadySteps(runId);
    } else if (result.status === 'rejected' && (result.source === 'validator' || result.source === 'freshness') && !rc.autoRetryStepIds.has(stepId)) {
      // Auto-retry only for a deterministic rejection (a concrete, fixable miss: a missing/empty
      // file, a leftover TODO, or a stale artifact the step didn't regenerate). A subjective LLM
      // rejection is surfaced to the user instead, so we don't burn a full re-run + re-review on a
      // verdict a retry is unlikely to flip.
      rc.autoRetryStepIds.add(stepId);
      this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: `\n[${result.source} rejected — retrying automatically (1/1)]\n` }));
      await this._run(runId, stepId);
    } else if (result.status === 'rejected') {
      // Final rejection (LLM verdict, or a second validator rejection): the flow halts here, so
      // write a full AI review report file (what's right/wrong, why, and how to fix it).
      await this._writeReviewReport(runId, step, stepId, { verdict: 'rejected', source: result.source, reason: result.note, correct: result.correct, issues: result.issues, suggestions: result.suggestions });
    }
  }

  /** Render + persist a per-step review report (approved or rejected); post its path to the webview. */
  private async _writeReviewReport(runId: string, step: FlowStep, stepId: string, report: {
    verdict: 'approved' | 'rejected';
    source: string;
    reason: string;
    correct?: string[];
    issues?: string[];
    suggestions?: string[];
  }): Promise<void> {
    const rc = this._runs.get(runId);
    if (!rc) return;
    const st = rc.runState.steps[stepId];
    const markdown = machine.renderReviewReport({
      step,
      flowName: rc.flow.name,
      runName: rc.runState.runName,
      runId: rc.runState.runId,
      verdict: report.verdict,
      source: report.source,
      reason: report.reason,
      correct: report.correct,
      issues: report.issues,
      suggestions: report.suggestions,
      startedAt: st?.startedAt,
      completedAt: st?.completedAt,
      reviewCompletedAt: st?.reviewCompletedAt,
      tokensUsed: st?.tokensUsed,
      costUsd: st?.costUsd,
      modelUsed: st?.modelUsed,
    });
    try {
      const filePath = await this.stateManager.saveReviewReport(rc.runState, stepId, markdown);
      if (filePath) {
        const base = filePath.split(/[\\/]/).pop();
        const rel = `.ai-stepflow/reports/reviews/${base}`;
        this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: `\n[AI review report written → ${rel}]\n` }));
        // Expose the report path to the webview so the step's Files tab can offer to open it.
        await this._setRunState(runId, s => ({ ...s, steps: { ...s.steps, [stepId]: { ...s.steps[stepId], reviewReportPath: rel } } }));
      }
    } catch (err) {
      // A report-write failure must not break the review flow (the rejection is already recorded).
      this.post(this._withRun(runId, { type: 'stepUpdate', stepId, append: true, output: `\n[could not write AI review report: ${err instanceof Error ? err.message : String(err)}]\n` }));
    }
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

  private _spawnClaudeStreaming(opts: ClaudeStreamingRunOptions, stepId?: string, isGeneration = false): Promise<ClaudeStreamingRunResult> {
    const handle = runClaudeStreaming({ mcpConfig: this._headlessMcpConfig(), ...opts, timeoutMs: opts.timeoutMs ?? this._runTimeoutMs() });
    this._activeRuns.add(handle.child);
    if (stepId) this._runChildrenByStep.set(stepId, handle.child);
    if (isGeneration) this._generationRuns.add(handle.child);
    return handle.completed.finally(() => {
      this._activeRuns.delete(handle.child);
      if (stepId && this._runChildrenByStep.get(stepId) === handle.child) this._runChildrenByStep.delete(stepId);
      if (isGeneration) this._generationRuns.delete(handle.child);
    });
  }

  /** Per-run output subfolder slug for `runId`, so each run's artifacts stay separate. */
  private _runSlug(runId: string): string {
    const rc = this._runs.get(runId);
    return runOutputSlug(rc?.runState.runName, rc?.runState.runId);
  }

  /** Legacy (pre-fingerprint) slug for `runId`, passed as a READ fallback so runs created before the
   * runId suffix existed still resolve their artifacts. '' when it equals the current slug. */
  private _legacyRunSlug(runId: string): string {
    const rc = this._runs.get(runId);
    return legacyRunOutputSlug(rc?.runState.runName, rc?.runState.runId);
  }

  /**
   * Change-signature (mtime + size) of a step's pinned Claude session transcript
   * `~/.claude/projects/<hash>/<sessionId>.jsonl`, or '' when there is no session id or file yet.
   * Used by the readiness probe as the authoritative "agent still working" signal: the transcript
   * grows on every message/tool-call, so a step that appears done by its declared artifact but is
   * still active keeps this signature changing until the agent truly goes idle.
   */
  private _sessionTranscriptSignature(runId: string, stepId: string): string {
    const sessionId = this._runs.get(runId)?.runState.steps[stepId]?.sessionId;
    const projectPath = this.configManager.getProjectPath();
    if (!sessionId || !projectPath) return '';
    try {
      const hash = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
      const file = path.join(os.homedir(), '.claude', 'projects', hash, `${sessionId}.jsonl`);
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '';
    }
  }

  private _validateRequires(runId: string, step: FlowStep): { ok: boolean; message?: string } {
    const rc = this._runs.get(runId);
    return validateRequires(step, this.configManager.getProjectPath() || '', rc?.runState.inputs || {}, rc?.flow.name || '', this._runSlug(runId), this._legacyRunSlug(runId));
  }

  /** Deterministic gate: the step's declared `produces`/review files must exist on disk. */
  private _validateProduces(runId: string, step: FlowStep): { ok: boolean; message?: string } {
    const rc = this._runs.get(runId);
    return validateProducesFiles(step, this.configManager.getProjectPath() || '', rc?.runState.inputs || {}, rc?.flow.name || '', this._runSlug(runId), this._legacyRunSlug(runId));
  }

  /**
   * Semantic gate: the produced files must satisfy the step's `producesContains` requirements.
   * Markers present verbatim pass for free; the rest are judged by an LLM (meaning, not exact
   * wording), so a draft need not echo the requirement text. Lenient on judge failure.
   */
  private _verifyProducesContent(runId: string, step: FlowStep): Promise<{ ok: boolean; message?: string }> {
    const rc = this._runs.get(runId);
    return verifyProducesContent(
      step,
      this.configManager.getProjectPath() || '',
      rc?.runState.inputs || {},
      rc?.flow.name || '',
      opts => this._spawnClaudeStreaming({ ...opts, maxTurns: 1 }),
      undefined,
      this._runSlug(runId),
      this._legacyRunSlug(runId)
    );
  }

  /**
   * Auto-run dependent steps once their dependencies are done (DAG orchestrator). On a
   * fan-out, each headless/AI branch launches concurrently — they have no shared UI.
   * Interactive (human/terminal) steps share one chat box, so only the first launches; the rest
   * are parked with a one-time message until a terminal slot frees up.
   */
  private _advanceReadySteps(runId: string): void {
    const rc = this._runs.get(runId);
    if (!rc) return;
    const orch = new machine.FlowOrchestrator(rc.flow, rc.runState);
    const actions = orch.getAutoAdvanceActions();
    rc.startedStepIds = orch.getStartedStepIds();

    for (const action of actions) {
      if (action.type === 'launch_interactive') {
        const step = rc.flow.steps.find(s => s.id === action.stepId);
        const hasAiReview = !!step && (step.review.type === 'ai' || !!step.review.reviewers?.some(r => r.type === 'ai'));

        // Auto-pilot runs every ready step itself (human-review steps run too, then halt at their
        // approval gate). Otherwise only AI-reviewed steps auto-run; the rest park for a manual click.
        if (hasAiReview || rc.runState.autoReview) {
          void this._run(runId, action.stepId);
        } else {
          if (rc.parkedStepIds.has(action.stepId)) continue;
          rc.parkedStepIds.add(action.stepId);
          this.post(this._withRun(runId, { type: 'stepUpdate', stepId: action.stepId, append: true, output: '\n[step ready — click "Run Step" to start]\n' }));
        }
      } else if (action.type === 'park_interactive') {
        if (rc.parkedStepIds.has(action.stepId)) continue;
        rc.parkedStepIds.add(action.stepId);
        this.post(this._withRun(runId, { type: 'stepUpdate', stepId: action.stepId, append: true, output: '\n[step ready — waiting for terminal slot...]\n' }));
      }
    }
  }

  /** Read session stats from Claude CLI's .jsonl files for an interactive step. Never throws. */
  private async _readInteractiveMetrics(runId: string, stepId: string): Promise<machine.StepMetrics> {
    const rc = this._runs.get(runId);
    const startTime = rc?.stepStartTimes.get(stepId)
      ?? (rc?.runState.steps[stepId]?.startedAt ? new Date(rc.runState.steps[stepId].startedAt!) : undefined);
    const projectPath = this.configManager.getProjectPath();
    if (!startTime || Number.isNaN(startTime.getTime()) || !projectPath) return {};
    const sessionId = rc?.runState.steps[stepId]?.sessionId;
    return readInteractiveSessionStats(projectPath, startTime, sessionId);
  }

  /** Persist recovered interactive metrics onto the step so the run JSON is the single UI source of truth. */
  private async _persistInteractiveMetrics(runId: string, stepId: string): Promise<void> {
    const rc = this._runs.get(runId);
    if (!rc) return;

    const metrics = await this._readInteractiveMetrics(runId, stepId);
    const hasMetrics = metrics.modelUsed != null || metrics.tokensUsed != null || metrics.costUsd != null || !!metrics.output;
    if (!hasMetrics) return;

    const prev = rc.runState.steps[stepId];
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

    await this._setRunState(runId, s => ({
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
   * Return the skills list for a run, loading from disk only on the first call per run and caching
   * on its RunCtx. Parallel steps of the same run share one read; a fresh RunCtx (new/reset run)
   * always sees fresh skills.
   */
  private async _getSkillsForRun(runId: string): Promise<Skill[]> {
    const rc = this._runs.get(runId);
    if (!rc) return this.configManager.loadSkills();
    if (!rc.skillsCache) {
      rc.skillsCache = await this.configManager.loadSkills();
    }
    return rc.skillsCache;
  }

  /**
   * Accumulate a streamed output chunk for a run's `stepId` and schedule a flush. The 50 ms
   * batch window prevents React from re-rendering on every token the LLM emits while
   * keeping perceived latency well within acceptable limits for a developer tool.
   */
  private _bufferOutput(runId: string, stepId: string, chunk: string): void {
    const rc = this._runs.get(runId);
    if (!rc) return;
    rc.outputChunkBuffer.set(stepId, (rc.outputChunkBuffer.get(stepId) ?? '') + chunk);
    if (!this._outputFlushTimer) {
      this._outputFlushTimer = setTimeout(() => this._flushOutputBuffer(), 50);
    }
  }

  /**
   * Flush every run's buffered output chunks to the webview in one postMessage per step, then
   * clear the buffers. Called by the shared 50 ms timer and also immediately at the end of each
   * run so the final tail of output is never left in the buffer.
   */
  private _flushOutputBuffer(): void {
    if (this._outputFlushTimer) {
      clearTimeout(this._outputFlushTimer);
      this._outputFlushTimer = undefined;
    }
    for (const [runId, rc] of this._runs) {
      for (const [stepId, text] of rc.outputChunkBuffer) {
        if (text) this.post({ type: 'stepUpdate', runId, stepId, append: true, output: text });
      }
      rc.outputChunkBuffer.clear();
    }
  }
}
