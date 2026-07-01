import * as vscode from 'vscode';
import { Agent } from '@ai-stepflow/core';
import { ConfigManager } from './configManager.js';

/**
 * Owns the single interactive `claude` terminal and its lifecycle, extracted from the
 * cockpit panel so the tricky shell-integration timing lives in one place. The panel
 * delegates ad-hoc agent/skill runs and the interactive (non-headless) step path here;
 * headless `claude -p` runs are unrelated and stay in the panel.
 */
export class TerminalManager {
  private _terminal: vscode.Terminal | undefined;
  /** Whether an interactive `claude` session is live in our terminal. */
  private _running = false;
  /** The shell execution that launched claude, so we can tell when it exits. */
  private _execution: vscode.TerminalShellExecution | undefined;
  /** The name of the agent currently running in our terminal, if any. */
  private _currentAgentName: string | undefined;
  /** The ID of the step currently running in our terminal, if any. */
  private _currentStepId: string | undefined;
  private _disposables: vscode.Disposable[] = [];
  /** Callback to notify when the terminal is closed while a step is running. */
  private _onDidCloseRunningStep: ((stepId: string) => void) | undefined;
  /** Callback to notify when the shell execution (claude session) ends while a step is running. */
  private _onDidEndRunningStep: ((stepId: string) => void) | undefined;

  constructor(private readonly configManager: ConfigManager) {
    this._disposables.push(
      vscode.window.onDidEndTerminalShellExecution(event => {
        if (event.execution === this._execution) {
          if (this._running && this._currentStepId && this._onDidEndRunningStep) {
            this._onDidEndRunningStep(this._currentStepId);
          }
          this._reset();
        }
      }),
      vscode.window.onDidCloseTerminal(terminal => {
        if (terminal === this._terminal) {
          if (this._running && this._currentStepId && this._onDidCloseRunningStep) {
            this._onDidCloseRunningStep(this._currentStepId);
          }
          this._reset();
        }
      })
    );
  }

  public onDidCloseRunningStep(cb: (stepId: string) => void): void {
    this._onDidCloseRunningStep = cb;
  }

  public onDidEndRunningStep(cb: (stepId: string) => void): void {
    this._onDidEndRunningStep = cb;
  }

  private _reset(): void {
    this._running = false;
    this._execution = undefined;
    this._currentAgentName = undefined;
    this._currentStepId = undefined;
  }

  /**
   * Open (or reuse) the interactive `claude` terminal for an ad-hoc or step run.
   * When `submit` is false the prompt is typed into the chat box but NOT sent, so the
   * user can review the agent/skill/model context and press Enter to start the run.
   *
   * Terminal lifecycle for a flow step run (a call carrying `stepId`): every "Run Step" gets a
   * brand-new terminal, except a Re-run whose step is still live in the current terminal, which
   * continues in place. Ad-hoc agent/skill runs (no `stepId`) keep the shared session and only
   * relaunch when the agent changes.
   */
  public async runInTerminal(prompt: string, projectPath: string, agent?: Agent | string, submit = true, stepId?: string, sessionId?: string): Promise<void> {
    const agentName = typeof agent === 'string' ? agent : agent?.name;

    const continueLiveStep = !!stepId && this._running && this._currentStepId === stepId;
    const adHocSwitch = !stepId && this._running && agentName !== this._currentAgentName;
    const needFreshTerminal = (!!stepId && !continueLiveStep) || adHocSwitch;

    if (needFreshTerminal && this._terminal) {
      this._terminal.dispose();
      this._terminal = undefined;
      this._execution = undefined;
      this._running = false;
    }

    const terminal = this._getTerminal(projectPath);
    terminal.show();

    if (this._running) {
      // Continue in the live terminal: a Re-run of the running step, or an ad-hoc follow-up
      // prompt for the same agent.
      if (prompt) terminal.sendText(prompt, submit);
      return;
    }

    const shellIntegration = await this._waitForShellIntegration(terminal);
    this._running = true;
    this._currentAgentName = agentName;
    this._currentStepId = stepId;

    const agentObj = typeof agent === 'string' ? (await this.configManager.loadAgents()).find(a => a.name === agent) : agent;
    const launchArgs = this._constructClaudeArgs(agentObj, sessionId);
    // Auto-submitted runs bake the prompt into the launch command. For a pre-fill (submit=false)
    // we launch claude bare, then type the prompt unsent once the REPL has come up.
    if (prompt && submit) launchArgs.push(prompt);

    if (shellIntegration) {
      this._execution = shellIntegration.executeCommand(this._shellQuoteArgs(launchArgs));
    } else {
      terminal.sendText(this._shellQuoteArgs(launchArgs), true);
    }

    if (prompt && !submit) {
      setTimeout(() => { try { terminal.sendText(prompt, false); } catch { /* terminal closed */ } }, 1500);
    }
  }

  private _constructClaudeArgs(agent?: Agent, sessionId?: string): string[] {
    const args = ['claude'];
    // Pin the session id so we can read exactly this run's .jsonl for metrics/output,
    // instead of guessing by project dir + time window (wrong when sessions run concurrently).
    if (sessionId) args.push('--session-id', sessionId);
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

  private async _waitForShellIntegration(terminal: vscode.Terminal, timeoutMs = 3000): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) return terminal.shellIntegration;
    return new Promise(resolve => {
      const timer = setTimeout(() => { listener.dispose(); resolve(undefined); }, timeoutMs);
      const listener = vscode.window.onDidChangeTerminalShellIntegration(event => {
        if (event.terminal === terminal) { clearTimeout(timer); listener.dispose(); resolve(event.shellIntegration); }
      });
    });
  }

  private _getTerminal(projectPath: string): vscode.Terminal {
    if (!this._terminal || this._terminal.exitStatus) {
      this._running = false;
      this._terminal = vscode.window.createTerminal({ name: 'AI StepFlow Claude', cwd: projectPath || undefined });
    }
    return this._terminal;
  }

  /** Kill the interactive terminal for a step. Returns true if the terminal was closed. */
  public cancelStep(stepId: string): boolean {
    if (this._currentStepId !== stepId || !this._running) return false;
    this._terminal?.dispose();
    this._terminal = undefined;
    return true;
  }

  public dispose(): void {
    while (this._disposables.length) this._disposables.pop()?.dispose();
  }
}
