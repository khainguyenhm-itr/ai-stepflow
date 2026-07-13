import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { existsSync, rmSync } from 'fs';
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
  /**
   * Readiness probe used only by the shell-integration fallback: returns whether the step's
   * declared artifacts already exist and are fresh (`true`/`false`), or `undefined` when the step
   * has nothing to gate on. Lets the fallback wait for the real artifact instead of guessing a
   * fixed duration.
   */
  private _isStepReady: ((stepId: string) => boolean | undefined) | undefined;
  /** Fallback timeout timer when shell integration is unavailable. */
  private _fallbackCompletionTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Path to the completion-sentinel file written by the shell after `claude` exits, when we launch
   * via `sendText` (no shell integration) on POSIX. Its appearance is a real process-exit signal —
   * the fallback polls for it instead of guessing from artifact activity. `undefined` on win32 or
   * for launches with no step, where the fallback falls back to the artifact readiness probe.
   */
  private _fallbackSentinelPath: string | undefined;

  constructor(private readonly configManager: ConfigManager) {
    this._disposables.push(
      vscode.window.onDidEndTerminalShellExecution(event => {
        if (event.execution === this._execution) {
          if (this._running && this._currentStepId && this._onDidEndRunningStep) {
            this._onDidEndRunningStep(this._currentStepId);
          }
          // Clear fallback timer if it was scheduled (shouldn't double-fire)
          if (this._fallbackCompletionTimer) {
            clearTimeout(this._fallbackCompletionTimer);
            this._fallbackCompletionTimer = undefined;
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

  /** Register the fallback readiness probe (see {@link _isStepReady}). */
  public onCheckStepReady(cb: (stepId: string) => boolean | undefined): void {
    this._isStepReady = cb;
  }

  private _reset(): void {
    this._running = false;
    this._execution = undefined;
    this._currentAgentName = undefined;
    this._currentStepId = undefined;
    if (this._fallbackCompletionTimer) {
      clearTimeout(this._fallbackCompletionTimer);
      this._fallbackCompletionTimer = undefined;
    }
    if (this._fallbackSentinelPath) {
      try { rmSync(this._fallbackSentinelPath, { force: true }); } catch { /* best-effort cleanup */ }
      this._fallbackSentinelPath = undefined;
    }
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
      // Fallback: shell integration unavailable, so we never get the real command-end event. On
      // POSIX we append `; touch <sentinel>` — the shell creates the file only after `claude` exits,
      // turning the fallback into a real process-exit poll rather than a guessed timeout. We only
      // check for the file's existence (not its content), and `touch` works from any mac/linux shell
      // (zsh/bash/fish). On win32 (no equivalent) we launch bare and lean on the readiness probe.
      const cmd = this._shellQuoteArgs(launchArgs);
      const sentinel = stepId ? this._prepareSentinel(stepId) : undefined;
      terminal.sendText(sentinel ? `${cmd}; touch ${this._shellQuote(sentinel)}` : cmd, true);
      if (stepId) this._scheduleFallbackCompletion(stepId);
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

  private _shellQuote(arg: string): string {
    return this._shellQuoteArgs([arg]);
  }

  /**
   * Pick a fresh completion-sentinel path for `stepId`, deleting any leftover from a prior run so
   * its later appearance unambiguously means THIS run's `claude` exited. Returns undefined on win32
   * (no reliable inline exit-code write for the fallback), leaving the artifact probe as the guard.
   */
  private _prepareSentinel(stepId: string): string | undefined {
    if (process.platform === 'win32') return undefined;
    const file = `aisf-done-${stepId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    const sentinelPath = path.join(os.tmpdir(), file);
    try { rmSync(sentinelPath, { force: true }); } catch { /* nothing to clear */ }
    this._fallbackSentinelPath = sentinelPath;
    return sentinelPath;
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

  /**
   * Fallback completion detection when shell integration is unavailable and the real
   * `onDidEndTerminalShellExecution` signal never arrives.
   *
   * A fixed timeout is wrong: a step may finish in 2 minutes or 5. Two signals, in order of trust:
   *   1) the completion sentinel (POSIX) — a file the shell writes only after `claude` exits, so its
   *      appearance is a genuine process-exit signal, not a guess;
   *   2) otherwise (win32 / no sentinel) the artifact readiness probe ({@link _isStepReady}) —
   *      complete once the declared artifacts exist and are fresh; a step with nothing to gate on
   *      (probe returns `undefined`) keeps the old fixed-delay behavior.
   * The configured run timeout is a hard cap so a stuck step can't hang forever. If shell execution
   * truly ends first, {@link _reset} clears the poll.
   */
  private _scheduleFallbackCompletion(stepId: string): void {
    if (this._fallbackCompletionTimer) {
      clearTimeout(this._fallbackCompletionTimer);
    }

    const hardCapMs = (vscode.workspace.getConfiguration('ai-stepflow').get<number>('run.timeoutSeconds', 600)) * 1000;
    const deadline = Date.now() + hardCapMs;
    const POLL_MS = 2_000;
    // Fallback delay for steps with no artifact to wait on (probe returns undefined).
    const NO_ARTIFACT_DELAY_MS = Math.min(hardCapMs, 30_000);
    const sentinelPath = this._fallbackSentinelPath;

    const fire = () => {
      if (this._running && this._currentStepId === stepId && this._onDidEndRunningStep) {
        this._onDidEndRunningStep(stepId);
      }
      this._reset();
    };

    const poll = () => {
      if (!this._running || this._currentStepId !== stepId) { this._fallbackCompletionTimer = undefined; return; }
      if (sentinelPath) {
        // Trusted signal: the sentinel exists only once `claude` has actually exited.
        if (existsSync(sentinelPath) || Date.now() >= deadline) { fire(); return; }
        this._fallbackCompletionTimer = setTimeout(poll, POLL_MS);
        return;
      }
      const ready = this._isStepReady ? this._isStepReady(stepId) : undefined;
      if (ready === undefined) {
        // Nothing to gate on — behave like the old fixed-delay fallback.
        this._fallbackCompletionTimer = setTimeout(fire, NO_ARTIFACT_DELAY_MS);
        return;
      }
      if (ready || Date.now() >= deadline) { fire(); return; }
      this._fallbackCompletionTimer = setTimeout(poll, POLL_MS);
    };

    this._fallbackCompletionTimer = setTimeout(poll, POLL_MS);
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
