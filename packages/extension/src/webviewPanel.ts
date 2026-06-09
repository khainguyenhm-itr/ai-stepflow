import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFile, ChildProcess } from 'child_process';
import { ConfigManager } from './configManager.js';
import { StateManager } from './stateManager.js';
import { validateMessage, WebviewMessage } from './messages.js';
import { listConnectedMcpServers } from './mcp.js';
import {
  Agent, Flow, FlowRunState, FlowStep, Skill,
  runClaudeStreaming, ClaudeStreamingRunOptions, ClaudeStreamingRunResult, composeSystemPrompt,
  validateProduces, validateRequires,
  renderRunReport,
  pickAutoAdvanceStep,
  seedStartedSteps,
  runValidator,
  renderVerifyReportMarkdown, verifyRun
} from '@ai-stepflow/core';
import * as machine from '@ai-stepflow/core';

export class CockpitPanel {
  public static currentPanel: CockpitPanel | undefined;
  private static readonly viewType = 'aiStepFlowCockpit';
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _currentFlow: Flow | undefined;
  private _runState: FlowRunState | undefined;
  private _claudeTerminal: vscode.Terminal | undefined;
  /** The name of the agent currently running in our interactive terminal, if any. */
  private _currentAgentName: string | undefined;
  /** Whether an interactive `claude` session is live in our terminal (ad-hoc agent/skill runs). */
  private _claudeRunning = false;
  /** The shell execution that launched claude, so we can tell when it exits. */
  private _claudeExecution: vscode.TerminalShellExecution | undefined;
  /** Headless `claude -p` runs (AI-step execution + AI review) in flight, killed on dispose. */
  private _activeRuns = new Set<ChildProcess>();
  /** The in-flight headless child per step, so a "Cancel" can kill exactly that run. */
  private _runChildrenByStep = new Map<string, ChildProcess>();
  /** Steps the user cancelled, so the resolving run handler skips its own failure transition. */
  private _cancelledStepIds = new Set<string>();
  /** Steps already launched in the current run, so the DAG orchestrator never starts one twice. Reset when the runId changes. */
  private _startedStepIds = new Set<string>();
  private _bookkeepingRunId: string | undefined;
  public static createOrShow(
    extensionUri: vscode.Uri,
    configManager: ConfigManager,
    stateManager: StateManager
  ) {
    if (CockpitPanel.currentPanel) {
      CockpitPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CockpitPanel.viewType,
      'AI StepFlow',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'out/webview')
        ]
      }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources/icon.svg');

    CockpitPanel.currentPanel = new CockpitPanel(panel, extensionUri, configManager, stateManager);
  }

  public static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    configManager: ConfigManager,
    stateManager: StateManager
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out/webview')]
    };
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources/icon.svg');
    CockpitPanel.currentPanel = new CockpitPanel(panel, extensionUri, configManager, stateManager);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private configManager: ConfigManager,
    private stateManager: StateManager
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      message => this._handleMessage(message).catch(error => {
        const text = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`AI StepFlow: ${text}`);
      }),
      null,
      this._disposables
    );

    this._disposables.push(
      vscode.window.onDidEndTerminalShellExecution(event => {
        if (event.execution === this._claudeExecution) {
          this._claudeRunning = false;
          this._claudeExecution = undefined;
          this._currentAgentName = undefined;
        }
      })
    );

    this._disposables.push(
      vscode.window.onDidCloseTerminal(terminal => {
        if (terminal === this._claudeTerminal) {
          this._claudeRunning = false;
          this._claudeExecution = undefined;
          this._currentAgentName = undefined;
        }
      })
    );
  }

  private async _handleMessage(raw: unknown): Promise<void> {
    const message = validateMessage(raw);
    if (!message) return;
    await this._dispatch(message);
  }

  private async _dispatch(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this._sendAllData();
        await this._restoreRunIfAny();
        return;
      case 'loadFlow':
        this._currentFlow = message.flow;
        this._runState = message.runState;
        return;
      case 'openFile':
        await this._handleOpenFile(message.path);
        return;
      case 'saveFlow': {
        const isGlobal = typeof message.isGlobal === 'boolean'
          ? message.isGlobal
          : this.configManager.isGlobalSourcePath(message.flow.sourcePath);
        await this.configManager.saveFlow(message.flow, isGlobal);
        await this._sendAllData();
        vscode.window.showInformationMessage(`Flow '${message.flow.name}' saved.`);
        return;
      }
      case 'createAgent':
        await this.configManager.saveAgent(message.agent, !!message.isGlobal);
        await this._sendAllData();
        vscode.window.showInformationMessage(`Agent '${message.agent.name}' created.`);
        return;
      case 'updateAgent': {
        const newPath = await this.configManager.saveAgent(message.agent, !!message.isGlobal);
        if (message.originalSourcePath && path.normalize(message.originalSourcePath) !== path.normalize(newPath)) {
          await this.configManager.deleteAgent(message.originalSourcePath);
        }
        await this._sendAllData();
        vscode.window.showInformationMessage(`Agent '${message.agent.name}' updated.`);
        return;
      }
      case 'createSkill':
        await this.configManager.saveSkill(message.skill, !!message.isGlobal);
        await this._sendAllData();
        vscode.window.showInformationMessage(`Skill '${message.skill.name}' created.`);
        return;
      case 'updateSkill': {
        const newPath = await this.configManager.saveSkill(message.skill, !!message.isGlobal);
        if (message.originalSourcePath && path.normalize(message.originalSourcePath) !== path.normalize(newPath)) {
          await this.configManager.deleteSkill(message.originalSourcePath);
        }
        await this._sendAllData();
        vscode.window.showInformationMessage(`Skill '${message.skill.name}' updated.`);
        return;
      }
      case 'deleteFlow': {
        const choice = await vscode.window.showWarningMessage(
          `Delete flow '${message.flow.name}'? This removes ${message.flow.sourcePath}.`,
          { modal: true },
          'Delete'
        );
        if (choice !== 'Delete') return;
        await this.configManager.deleteFlow(message.flow.sourcePath);
        if (this._currentFlow?.id === message.flow.id) {
          this._currentFlow = undefined;
          this._runState = undefined;
        }
        await this._sendAllData();
        vscode.window.showInformationMessage(`Flow '${message.flow.name}' deleted.`);
        return;
      }
      case 'deleteAgent': {
        const choice = await vscode.window.showWarningMessage(
          `Delete agent '${message.agent.name}'? This removes ${message.agent.sourcePath}.`,
          { modal: true },
          'Delete'
        );
        if (choice !== 'Delete') return;
        await this.configManager.deleteAgent(message.agent.sourcePath);
        await this._sendAllData();
        vscode.window.showInformationMessage(`Agent '${message.agent.name}' deleted.`);
        return;
      }
      case 'deleteSkill': {
        const choice = await vscode.window.showWarningMessage(
          `Delete skill '${message.skill.name}'? This removes its skill file and any bundled resources.`,
          { modal: true },
          'Delete'
        );
        if (choice !== 'Delete') return;
        await this.configManager.deleteSkill(message.skill.sourcePath);
        await this._sendAllData();
        vscode.window.showInformationMessage(`Skill '${message.skill.name}' deleted.`);
        return;
      }
      case 'updateRunState':
        this._runState = message.runState;
        await this.stateManager.saveRun(this._runState!);
        if (message.historyEvent) {
          await this.stateManager.appendAuditLog(this._runState.flowId, this._runState.runId, message.historyEvent.stepId, {
            timestamp: message.historyEvent.timestamp,
            status: message.historyEvent.status,
            message: message.historyEvent.message
          });
        }
        return;
      case 'runStep':
        // The webview owns flow selection and seeds the initial run state; the backend
        // takes ownership of every transition from here on (it is the state machine).
        if (message.flow) this._currentFlow = message.flow;
        // Seed the backend's authoritative state only for a new run; mid-run, the backend's
        // own state wins so a stale webview mirror can never roll a transition back.
        if (message.runState && (!this._runState || this._runState.runId !== message.runState.runId)) {
          this._runState = message.runState;
        }
        await this._handleRunStep(message.stepId, message.description);
        return;
      case 'cancelStep':
        this._handleCancelStep(message.stepId);
        return;
      case 'runAgent':
        await this._handleRunAgent(message.agent, message.description);
        return;
      case 'runSkill':
        await this._handleRunSkill(message.skill, message.description);
        return;
      case 'submitHumanReview':
        if (this._currentFlow && this._runState) {
          const decision = message.review.decision;
          this._setRunState(machine.applyHumanReview(this._runState, this._currentFlow, message.stepId, message.review), { stepId: message.stepId, status: decision, message: `Human review ${decision}` });
        }
        return;
      case 'markStepDone': {
        if (!this._currentFlow || !this._runState) return;
        const flow = this._currentFlow;
        const step = flow.steps.find(s => s.id === message.stepId);
        if (!step) return;

        const req = this._validateRequires(step);
        if (!req.ok) {
          this.postMessage({ type: 'stepUpdate', stepId: message.stepId, append: true, output: `\n[cannot mark done — requires check failed: ${req.message}]\n` });
          vscode.window.showErrorMessage(`Step '${step.title || step.id}' cannot be marked done: ${req.message}`);
          return;
        }
        const prod = this._validateProduces(step);
        if (!prod.ok) {
          this.postMessage({ type: 'stepUpdate', stepId: message.stepId, append: true, output: `\n[cannot mark done — produces check failed: ${prod.message}]\n` });
          vscode.window.showErrorMessage(`Step '${step.title || step.id}' cannot be marked done: ${prod.message}`);
          return;
        }

        const rs = this._runState.steps[message.stepId];
        // No review gate, or a reviewer already approved → finish and advance.
        if (!step.review?.required || rs?.reviewStatus === 'approved' || rs?.completionStatus === 'ready_to_mark_done') {
          this._setRunState(machine.markDone(this._runState, flow, message.stepId), { stepId: message.stepId, status: 'completed', message: 'Marked done' });
          this._advanceReadySteps();
          return;
        }

        // Review required and not yet satisfied: record the run as completed (this opens the
        // review gate, setting reviewStatus to 'pending'), then run the artifact review or
        // wait for a human decision.
        this._setRunState(machine.markCompleted(this._runState, flow, message.stepId), { stepId: message.stepId, status: 'completed', message: 'Run completed — reviewing' });
        await this._reviewStep(step, message.stepId);
        return;
      }
      case 'verifyRun':
        await this._handleVerifyRun();
        return;
      case 'exportRunReport':
        await this._handleExportRunReport();
        return;
      case 'importAgentFile':
        await this._handleImportFile('agent');
        return;
      case 'importSkillFile':
        await this._handleImportFile('skill');
        return;
      case 'generateDraft':
        await this._handleGenerateDraft(message.kind, message.name, message.description);
        return;
      case 'alert':
        vscode.window.showErrorMessage(message.text);
        return;
    }
  }

  private async _handleImportFile(kind: 'agent' | 'skill'): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: `Import ${kind}`,
      filters: { Markdown: ['md'] }
    });
    const fileUri = picked?.[0];
    if (!fileUri) return;

    if (kind === 'agent') {
      const agent = await this.configManager.importAgentFromFile(fileUri.fsPath);
      if (agent) {
        this.postMessage({ type: 'fileImported', kind, item: { name: agent.name, description: agent.description, model: agent.model, tools: agent.tools?.join(', ') ?? '', systemPrompt: agent.systemPrompt } });
      }
    } else {
      const skill = await this.configManager.importSkillFromFile(fileUri.fsPath);
      if (skill) {
        this.postMessage({ type: 'fileImported', kind, item: { name: skill.name, description: skill.description, instructions: skill.instructions } });
      }
    }
  }

  private async _handleGenerateDraft(kind: 'agent' | 'skill', name: string, description?: string): Promise<void> {
    const target = kind === 'agent' ? 'a system prompt for a Claude Code subagent' : 'the instruction body for a reusable Claude Code skill';
    const metaPrompt = [`Write ${target}.`, `Name: ${name}`, description?.trim() ? `Purpose: ${description.trim()}` : '', '', 'Rules:', '- Return ONLY markdown.', '- Be concise.'].join('\n');

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Drafting ${kind}...` }, () => new Promise<void>(resolve => {
      execFile('claude', ['-p', metaPrompt], { cwd: this.configManager.getProjectPath() || undefined }, (error, stdout) => {
        if (error) {
          console.error('AI StepFlow: draft generation failed', error);
          vscode.window.showErrorMessage(`AI StepFlow: could not draft ${kind} — ${error.message}`);
        } else {
          this.postMessage({ type: 'draftGenerated', kind, content: stdout.trim() });
        }
        resolve();
      });
    }));
  }

  public async refreshData(): Promise<void> {
    await this._sendAllData();
  }

  private async _restoreRunIfAny(): Promise<void> {
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
    this.postMessage({ type: 'restoreRun', flow, runState });
  }

  private async _sendAllData() {
    try {
      const [flows, agents, skills] = await Promise.all([
        this.configManager.loadFlows().catch(e => { console.error('AI StepFlow: loadFlows failed', e); return []; }),
        this.configManager.loadAgents().catch(e => { console.error('AI StepFlow: loadAgents failed', e); return []; }),
        this.configManager.loadSkills().catch(e => { console.error('AI StepFlow: loadSkills failed', e); return []; })
      ]);
      const auditLogs: Record<string, any[]> = {};
      await Promise.all(flows.map(async flow => { 
        try {
          auditLogs[flow.id] = await this.stateManager.loadAuditLog(flow.id); 
        } catch (e) {
          auditLogs[flow.id] = [];
        }
      }));
      
      const projectPath = this.configManager.getProjectPath() || '';
      const globalPath = this.configManager.getGlobalPath() || '';

      this.postMessage({ 
        type: 'loadData', 
        flows, agents, skills, 
        connectedMcpServers: [], 
        auditLogs, 
        globalPath, 
        projectPath 
      });

      if (projectPath) {
        void listConnectedMcpServers(projectPath).then(connectedMcpServers => { 
          this.postMessage({ type: 'mcpServers', connectedMcpServers }); 
        }).catch(err => {
          console.error('AI StepFlow: MCP probe failed', err);
        });
      }
    } catch (err) {
      console.error('AI StepFlow: _sendAllData critical failure', err);
      // Even if everything fails, send minimal data to unblock the UI
      this.postMessage({ 
        type: 'loadData', 
        flows: [], agents: [], skills: [], 
        connectedMcpServers: [], 
        auditLogs: {}, 
        globalPath: '', 
        projectPath: '' 
      });
    }
  }

  private async _handleOpenFile(filePath: string | undefined) {
    if (!filePath) return;
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.configManager.getProjectPath() || '', filePath);
    if (!fs.existsSync(absPath)) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async _handleRunStep(stepId: string, description?: string) {
    if (!this._currentFlow || !this._runState) return;
    const flow = this._currentFlow;
    const step = flow.steps.find(s => s.id === stepId);
    if (!step) return;

    this._resetBookkeepingIfNewRun();

    // Never start a step before the steps it depends on are done — the backend is the
    // authority, so auto-advanced and hand-clicked runs share one guard against the run state.
    const deps = step.dependsOn ?? [];
    const done = machine.doneStepIds(this._runState);
    if (!deps.every(d => done.has(d))) return;

    const req = this._validateRequires(step);
    if (!req.ok) {
      this.postMessage({ type: 'stepUpdate', stepId, append: true, output: `\n[step blocked — ${req.message}]\n` });
      vscode.window.showErrorMessage(`Step '${step.title || step.id}' is blocked: ${req.message}`);
      return;
    }

    const agents = await this.configManager.loadAgents();
    const agent = agents.find(a => a.name === step.agent);
    const stepSkillNames = step.skills && step.skills.length ? step.skills : (step.skill ? [step.skill] : []);
    if (!agent || stepSkillNames.length === 0) return;

    this._startedStepIds.add(stepId);
    const projectPath = this.configManager.getProjectPath() || '';

    const aiReview = !!step.review?.required && (step.review.type === 'ai' || !!step.review.reviewers?.some(r => r.type === 'ai'));

    // AI-reviewed steps run HEADLESS so the run completion is observable: when claude exits we
    // capture the output, then automatically run the two-layer review and auto-advance on a pass
    // — no Enter, no "Mark step done" click.
    if (aiReview) {
      const skills = await this.configManager.loadSkills();
      const systemPrompt = composeSystemPrompt(agent, stepSkillNames, skills);
      const userMessage = description?.trim() || step.input?.prompt?.trim() || `Run step: ${step.title || step.id}`;
      this._setRunState(machine.markRunning(this._runState, flow, stepId), { stepId, status: 'running', message: 'Run started (headless, auto-review)' });

      let output = '';
      const result = await this._spawnClaudeStreaming({
        systemPrompt, userMessage, model: agent.model, projectPath,
        onText: chunk => { output += chunk; this.postMessage({ type: 'stepUpdate', stepId, append: true, output: chunk }); }
      }, stepId);
      // The user cancelled this run: _handleCancelStep already moved the step to 'cancelled',
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
    const desc = description?.trim() || step.input?.prompt?.trim() || `Run step: ${step.title || step.id}`;
    const message = primarySkill ? `/${primarySkill} ${desc}` : desc;

    this._setRunState(machine.markRunning(this._runState, flow, stepId), { stepId, status: 'running', message: 'Opened in Claude — press Enter to run' });
    this.postMessage({ type: 'stepUpdate', stepId, append: true, output: `\n[opened in the Claude terminal — review the pre-filled message, press Enter to run, then click "Mark step done"]\n` });
    await this._runInTerminal(message, projectPath, agent, false);
  }

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
    this.postMessage({ type: 'runStateChanged', runState: next, historyEvent });
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
      this.postMessage({ type: 'stepUpdate', stepId, append: true, output: `\n[${note}]\n` });
      if (status === 'approved') this._advanceReadySteps();
      return;
    }
    // Human-only review: wait for a decision via the approve/reject buttons. markCompleted
    // already set reviewStatus to 'pending', so the approve/reject UI is shown for this step.
    this.postMessage({ type: 'stepUpdate', stepId, append: true, output: `\n[review required — approve or reject this step to continue]\n` });
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
      onText: chunk => { reviewOut += chunk; this.postMessage({ type: 'aiReviewUpdate', stepId, append: true, output: chunk }); }
    });

    const detail = (reviewOut ? `${reviewOut}\n` : '') + `Review (${result.source}): ${result.status} — ${result.note}\n`;
    this._setRunState(machine.applyAiReview(this._runState, flow, stepId, result.status, detail), { stepId, status: result.status, message: `Review ${result.status}` });
    this.postMessage({ type: 'stepUpdate', stepId, append: true, output: `\n[review (${result.source}): ${result.status} — ${result.note}]\n` });
    if (result.status === 'approved') this._advanceReadySteps();
  }

  /** Configured per-run timeout in ms (0 = no limit). */
  private _runTimeoutMs(): number {
    const seconds = vscode.workspace.getConfiguration('ai-stepflow').get<number>('run.timeoutSeconds', 600);
    return seconds > 0 ? seconds * 1000 : 0;
  }

  /**
   * Run `claude` headless with stream-json output. The child is tracked in `_activeRuns`
   * (killed on dispose) and, when a `stepId` is given, in `_runChildrenByStep` so a user
   * "Cancel" can kill exactly that run. A configured per-run timeout caps a hung run.
   */
  private _spawnClaudeStreaming(opts: ClaudeStreamingRunOptions, stepId?: string): Promise<ClaudeStreamingRunResult> {
    const handle = runClaudeStreaming({ ...opts, timeoutMs: opts.timeoutMs ?? this._runTimeoutMs() });
    this._activeRuns.add(handle.child);
    if (stepId) this._runChildrenByStep.set(stepId, handle.child);
    return handle.completed.finally(() => {
      this._activeRuns.delete(handle.child);
      if (stepId && this._runChildrenByStep.get(stepId) === handle.child) this._runChildrenByStep.delete(stepId);
    });
  }

  /** Kill the in-flight headless run for a step and record it as cancelled. No-op for terminal runs. */
  private _handleCancelStep(stepId: string): void {
    const child = this._runChildrenByStep.get(stepId);
    if (!child) return;
    this._cancelledStepIds.add(stepId);
    child.kill();
    this.postMessage({ type: 'stepUpdate', stepId, append: true, output: '\n[run cancelled by user]\n' });
    if (this._currentFlow && this._runState) {
      this._setRunState(machine.markCancelled(this._runState, this._currentFlow, stepId), { stepId, status: 'cancelled', message: 'Cancelled by user' });
    }
  }

  private _validateRequires(step: FlowStep): { ok: boolean; message?: string } {
    return validateRequires(step, this.configManager.getProjectPath() || '', this._runState?.inputs || {});
  }

  /** Verify a step's declared `produces` files exist and contain any required markers. */
  private _validateProduces(step: FlowStep): { ok: boolean; message?: string } {
    return validateProduces(step, this.configManager.getProjectPath() || '', this._runState?.inputs || {});
  }

  private async _handleVerifyRun(): Promise<void> {
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

  private async _handleExportRunReport(): Promise<void> {
    if (!this._currentFlow || !this._runState) return;
    const auditLog = await this.stateManager.loadAuditLog(this._currentFlow.id);
    const markdown = renderRunReport(this._currentFlow, this._runState, auditLog);
    const filePath = await this.stateManager.saveReport(this._currentFlow.id, this._runState.runId, markdown);
    if (!filePath) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage(`AI StepFlow: run report exported to ${path.basename(filePath)}.`);
  }

  /** Auto-run dependent steps once all of their dependencies are done (the DAG orchestrator). */
  private _advanceReadySteps(): void {
    if (!this._currentFlow || !this._runState) return;
    this._resetBookkeepingIfNewRun();
    const done = machine.doneStepIds(this._runState);
    const next = pickAutoAdvanceStep(this._currentFlow.steps, done, this._startedStepIds);
    if (next) void this._handleRunStep(next);
  }

  private _resetBookkeepingIfNewRun(): void {
    const runId = this._runState?.runId;
    if (runId === this._bookkeepingRunId) return;
    this._bookkeepingRunId = runId;
    this._startedStepIds = this._runState ? seedStartedSteps(this._runState.steps) : new Set<string>();
  }

  private _constructClaudeArgs(agent?: Agent): string[] {
    const args = ['claude'];
    if (agent) {
      args.push('--agent', agent.name);
      if (agent.model) args.push('--model', agent.model);
    }
    return args;
  }

  private _shellQuoteArgs(args: string[]): string {
    return args.map(arg => {
      if (arg.includes(' ') || arg.includes('"') || arg.includes("'") || arg.startsWith('/')) {
        return process.platform === 'win32' ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, "'\\''")}'`;
      }
      return arg;
    }).join(' ');
  }

  private async _handleRunAgent(agent: Agent | undefined, description?: string) {
    if (agent) await this._runInTerminal(description?.trim() || '', this.configManager.getProjectPath() || '', agent);
  }

  private async _handleRunSkill(skill: Skill | undefined, description?: string) {
    if (skill) await this._runInTerminal(this._buildCommandPrompt(skill.name, description), this.configManager.getProjectPath() || '');
  }

  private _buildCommandPrompt(commandName: string, description?: string): string {
    return description?.trim() ? `/${commandName} ${description.trim()}` : `/${commandName}`;
  }

  /**
   * Open (or reuse) the interactive `claude` terminal for an ad-hoc or step run.
   * When `submit` is false the prompt is typed into the chat box but NOT sent, so the
   * user can review the agent/skill/model context and press Enter to start the run.
   */
  private async _runInTerminal(prompt: string, projectPath: string, agent?: Agent | string, submit = true): Promise<void> {
    const terminal = this._getClaudeTerminal(projectPath);
    terminal.show();

    const agentName = typeof agent === 'string' ? agent : agent?.name;
    if (this._claudeRunning && agentName !== this._currentAgentName) {
      this._claudeTerminal?.dispose();
      this._claudeTerminal = undefined;
      this._claudeRunning = false;
      return this._runInTerminal(prompt, projectPath, agent, submit);
    }

    if (this._claudeRunning) {
      if (prompt) terminal.sendText(prompt, submit);
      return;
    }

    const shellIntegration = await this._waitForShellIntegration(terminal);
    this._claudeRunning = true;
    this._currentAgentName = agentName;

    const agentObj = typeof agent === 'string' ? (await this.configManager.loadAgents()).find(a => a.name === agent) : agent;
    const launchArgs = this._constructClaudeArgs(agentObj);
    // Auto-submitted runs bake the prompt into the launch command. For a pre-fill (submit=false)
    // we launch claude bare, then type the prompt unsent once the REPL has come up.
    if (prompt && submit) launchArgs.push(prompt);

    if (shellIntegration) {
      this._claudeExecution = shellIntegration.executeCommand(this._shellQuoteArgs(launchArgs));
    } else {
      terminal.sendText(this._shellQuoteArgs(launchArgs), true);
    }

    if (prompt && !submit) {
      setTimeout(() => { try { terminal.sendText(prompt, false); } catch { /* terminal closed */ } }, 1500);
    }
  }

  private async _waitForShellIntegration(terminal: vscode.Terminal, timeoutMs = 3000): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) return terminal.shellIntegration;
    return new Promise(resolve => {
      const timer = setTimeout(() => { listener.dispose(); resolve(undefined); }, timeoutMs);
      const listener = vscode.window.onDidChangeTerminalShellIntegration(event => {
        if (event.terminal === terminal) { clearTimeout(timer); listener.dispose(); resolve(event.shellIntegration); }
      });
    });
  }

  private _getClaudeTerminal(projectPath: string): vscode.Terminal {
    if (!this._claudeTerminal || this._claudeTerminal.exitStatus) {
      this._claudeRunning = false;
      this._claudeTerminal = vscode.window.createTerminal({ name: 'AI StepFlow Claude', cwd: projectPath || undefined });
    }
    return this._claudeTerminal;
  }

  public dispose() {
    CockpitPanel.currentPanel = undefined;
    for (const child of this._activeRuns) child.kill();
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _update() { this._panel.webview.html = this._getHtmlForWebview(this._panel.webview); }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out/webview', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out/webview', 'main.css'));
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [`default-src 'none'`, `img-src ${webview.cspSource} data:`, `font-src ${webview.cspSource}`, `style-src ${webview.cspSource} 'unsafe-inline'`, `script-src 'nonce-${nonce}'`].join('; ');
    let html = fs.readFileSync(path.join(this._extensionUri.fsPath, 'out/webview/index.html'), 'utf8');
    html = html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);
    html = html.replace('href="main.css"', `href="${styleUri}"`);
    html = html.replace('src="main.js"', `nonce="${nonce}" src="${scriptUri}"`);
    return html;
  }

  public postMessage(message: any) { this._panel.webview.postMessage(message); }
}
