import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { existsSync, rmSync } from 'fs';
import { Agent, shortRunId } from '@ai-stepflow/core';
import { ConfigManager } from './configManager.js';

/** Key for ad-hoc agent/skill runs (no flow step). One shared ad-hoc terminal, as before. */
const ADHOC_KEY = '#adhoc';

/** Per-terminal state: one live interactive `claude` session and its lifecycle bookkeeping. */
interface TermState {
  terminal: vscode.Terminal;
  running: boolean;
  execution?: vscode.TerminalShellExecution;
  agentName?: string;
  /** Owning run + step (undefined for the ad-hoc terminal). */
  runId?: string;
  stepId?: string;
  fallbackTimer?: ReturnType<typeof setTimeout>;
  /** POSIX completion-sentinel file path, when launched via sendText (no shell integration). */
  sentinelPath?: string;
  /** Set by {@link cancelStep} when a Stop arrives during the shell-integration wait, before live. */
  launchAborted?: boolean;
}

/**
 * Owns the interactive `claude` terminals and their lifecycle, extracted from the cockpit panel so
 * the tricky shell-integration timing lives in one place. Each flow-step run gets its OWN terminal,
 * keyed by `${runId}::${stepId}`, so multiple runs can hold live interactive sessions concurrently.
 * Ad-hoc agent/skill runs (no step) share one terminal under {@link ADHOC_KEY}. Headless `claude -p`
 * runs are unrelated and stay in the panel.
 */
export class TerminalManager {
  private _terms = new Map<string, TermState>();
  private _disposables: vscode.Disposable[] = [];
  /** Callback when a terminal is closed while its step is running. */
  private _onDidCloseRunningStep: ((runId: string, stepId: string) => void) | undefined;
  /** Callback when the shell execution (claude session) ends while its step is running. */
  private _onDidEndRunningStep: ((runId: string, stepId: string) => void) | undefined;
  /**
   * Readiness probe used only by the shell-integration fallback: returns whether the step's
   * declared artifacts already exist and are fresh (`true`/`false`), or `undefined` when the step
   * has nothing to gate on. Lets the fallback wait for the real artifact instead of guessing.
   */
  private _isStepReady: ((runId: string, stepId: string) => boolean | undefined) | undefined;

  constructor(private readonly configManager: ConfigManager) {
    this._disposables.push(
      vscode.window.onDidEndTerminalShellExecution(event => {
        const entry = this._findByExecution(event.execution);
        if (!entry) return;
        const [key, state] = entry;
        if (state.running && state.runId && state.stepId && this._onDidEndRunningStep) {
          this._onDidEndRunningStep(state.runId, state.stepId);
        }
        this._disposeState(key);
      }),
      vscode.window.onDidCloseTerminal(terminal => {
        const entry = this._findByTerminal(terminal);
        if (!entry) return;
        const [key, state] = entry;
        if (state.running && state.runId && state.stepId && this._onDidCloseRunningStep) {
          this._onDidCloseRunningStep(state.runId, state.stepId);
        }
        this._disposeState(key);
      })
    );
  }

  public onDidCloseRunningStep(cb: (runId: string, stepId: string) => void): void {
    this._onDidCloseRunningStep = cb;
  }

  public onDidEndRunningStep(cb: (runId: string, stepId: string) => void): void {
    this._onDidEndRunningStep = cb;
  }

  /** Register the fallback readiness probe (see {@link _isStepReady}). */
  public onCheckStepReady(cb: (runId: string, stepId: string) => boolean | undefined): void {
    this._isStepReady = cb;
  }

  private _key(runId: string | undefined, stepId: string): string { return `${runId ?? ''}::${stepId}`; }

  private _findByExecution(execution: vscode.TerminalShellExecution): [string, TermState] | undefined {
    for (const entry of this._terms) if (entry[1].execution === execution) return entry;
    return undefined;
  }

  private _findByTerminal(terminal: vscode.Terminal): [string, TermState] | undefined {
    for (const entry of this._terms) if (entry[1].terminal === terminal) return entry;
    return undefined;
  }

  /** Clear a run's terminal state: cancel its fallback timer, remove its sentinel, drop the entry. */
  private _disposeState(key: string): void {
    const state = this._terms.get(key);
    if (!state) return;
    if (state.fallbackTimer) { clearTimeout(state.fallbackTimer); state.fallbackTimer = undefined; }
    if (state.sentinelPath) {
      try { rmSync(state.sentinelPath, { force: true }); } catch { /* best-effort cleanup */ }
      state.sentinelPath = undefined;
    }
    this._terms.delete(key);
  }

  /**
   * Open (or reuse) an interactive `claude` terminal for an ad-hoc or step run.
   * When `submit` is false the prompt is typed into the chat box but NOT sent, so the
   * user can review the agent/skill/model context and press Enter to start the run.
   *
   * Each flow step (a call carrying `stepId`) gets its own terminal keyed by `${runId}::${stepId}`,
   * except a Re-run whose step is still live, which continues in place. Ad-hoc agent/skill runs
   * (no `stepId`) keep the shared session and only relaunch when the agent changes.
   */
  public async runInTerminal(prompt: string, projectPath: string, agent?: Agent | string, submit = true, stepId?: string, sessionId?: string, runId?: string): Promise<void> {
    const agentName = typeof agent === 'string' ? agent : agent?.name;
    const key = stepId ? this._key(runId, stepId) : ADHOC_KEY;
    let state = this._terms.get(key);

    const continueLiveStep = !!stepId && !!state?.running;
    const adHocSwitch = !stepId && !!state?.running && agentName !== state?.agentName;
    const needFreshTerminal = (!!stepId && !continueLiveStep) || adHocSwitch;

    if (needFreshTerminal && state?.terminal) {
      state.terminal.dispose();
      this._disposeState(key);
      state = undefined;
    }

    const terminal = this._getTerminal(key, projectPath, runId, stepId);
    terminal.show();
    state = this._terms.get(key)!;

    if (state.running) {
      // Continue in the live terminal: a Re-run of the running step, or an ad-hoc follow-up prompt.
      if (prompt) terminal.sendText(prompt, submit);
      return;
    }

    // Claim the step BEFORE awaiting shell integration so a Stop pressed during that window is
    // recognized by cancelStep and aborts this launch — otherwise the claude terminal would come up
    // after the cancel with nothing able to close it.
    state.stepId = stepId;
    state.runId = runId;
    state.launchAborted = false;

    const shellIntegration = await this._waitForShellIntegration(terminal);
    const cur = this._terms.get(key);
    if (!cur || cur.terminal !== terminal) return; // disposed/replaced during the await
    if (stepId && cur.launchAborted) {
      // Cancelled during the shell-integration wait: dispose and do not launch. The orchestrator
      // has already recorded the step as cancelled.
      cur.launchAborted = false;
      cur.terminal.dispose();
      this._disposeState(key);
      return;
    }
    cur.running = true;
    cur.agentName = agentName;

    const agentObj = typeof agent === 'string' ? (await this.configManager.loadAgents()).find(a => a.name === agent) : agent;
    const launchArgs = this._constructClaudeArgs(agentObj, sessionId);
    // Auto-submitted runs bake the prompt into the launch command. For a pre-fill (submit=false)
    // we launch claude bare, then type the prompt unsent once the REPL has come up.
    if (prompt && submit) launchArgs.push(prompt);

    if (shellIntegration) {
      cur.execution = shellIntegration.executeCommand(this._shellQuoteArgs(launchArgs));
      // `onDidEndTerminalShellExecution` only fires when `claude` exits, but a step runs an
      // interactive REPL that stays alive after finishing — so also poll the artifact readiness
      // probe. Whichever completion signal fires first wins (_disposeState clears the other).
      if (stepId) this._scheduleFallbackCompletion(key);
    } else {
      // Fallback: shell integration unavailable, so we never get the real command-end event. On
      // POSIX we append `; touch <sentinel>` — the shell creates the file only after `claude` exits,
      // turning the fallback into a real process-exit poll rather than a guessed timeout.
      const cmd = this._shellQuoteArgs(launchArgs);
      const sentinel = stepId ? this._prepareSentinel(key, runId, stepId) : undefined;
      terminal.sendText(sentinel ? `${cmd}; touch ${this._shellQuote(sentinel)}` : cmd, true);
      if (stepId) this._scheduleFallbackCompletion(key);
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
   * Pick a fresh completion-sentinel path for a run's step, deleting any leftover so its later
   * appearance unambiguously means THIS run's `claude` exited. The runId fingerprint keeps two
   * concurrent runs of the same stepId from sharing a sentinel. Returns undefined on win32.
   */
  private _prepareSentinel(key: string, runId: string | undefined, stepId: string): string | undefined {
    if (process.platform === 'win32') return undefined;
    const safe = `${shortRunId(runId)}-${stepId}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const sentinelPath = path.join(os.tmpdir(), `aisf-done-${safe}`);
    try { rmSync(sentinelPath, { force: true }); } catch { /* nothing to clear */ }
    const state = this._terms.get(key);
    if (state) state.sentinelPath = sentinelPath;
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
   * `onDidEndTerminalShellExecution` signal never arrives. Two signals, in order of trust:
   *   1) the completion sentinel (POSIX) — a file the shell writes only after `claude` exits;
   *   2) otherwise the artifact readiness probe ({@link _isStepReady}). The configured run timeout
   * is a hard cap so a stuck step can't hang forever.
   */
  private _scheduleFallbackCompletion(key: string): void {
    const state = this._terms.get(key);
    if (!state) return;
    if (state.fallbackTimer) clearTimeout(state.fallbackTimer);

    const hardCapMs = (vscode.workspace.getConfiguration('ai-stepflow').get<number>('run.timeoutSeconds', 600)) * 1000;
    const deadline = Date.now() + hardCapMs;
    const POLL_MS = 2_000;
    const NO_ARTIFACT_DELAY_MS = Math.min(hardCapMs, 30_000);

    const fire = () => {
      const s = this._terms.get(key);
      if (s?.running && s.runId && s.stepId && this._onDidEndRunningStep) {
        this._onDidEndRunningStep(s.runId, s.stepId);
      }
      this._disposeState(key);
    };

    const poll = () => {
      const s = this._terms.get(key);
      if (!s || !s.running) { if (s) s.fallbackTimer = undefined; return; }
      const ready = (this._isStepReady && s.runId && s.stepId) ? this._isStepReady(s.runId, s.stepId) : undefined;
      if (ready !== undefined) {
        // Step declares artifacts: complete once they exist and go quiescent, WITHOUT waiting for
        // `claude` to exit (the REPL stays alive after the prompt finishes). Hard cap bounds a stuck step.
        if (ready || Date.now() >= deadline) { fire(); return; }
        s.fallbackTimer = setTimeout(poll, POLL_MS);
        return;
      }
      // Nothing to gate on. Trust the process-exit sentinel if we have one (POSIX); otherwise fall
      // back to the old fixed delay (win32 / no sentinel).
      if (s.sentinelPath) {
        if (existsSync(s.sentinelPath) || Date.now() >= deadline) { fire(); return; }
        s.fallbackTimer = setTimeout(poll, POLL_MS);
        return;
      }
      s.fallbackTimer = setTimeout(fire, NO_ARTIFACT_DELAY_MS);
    };

    state.fallbackTimer = setTimeout(poll, POLL_MS);
  }

  private _getTerminal(key: string, projectPath: string, runId?: string, stepId?: string): vscode.Terminal {
    const existing = this._terms.get(key);
    if (existing && existing.terminal && !existing.terminal.exitStatus) return existing.terminal;
    // Distinct, human-readable name so concurrent runs are distinguishable in the terminal picker.
    const name = stepId ? `Claude ${stepId}·${shortRunId(runId)}` : 'AI StepFlow Claude';
    const terminal = vscode.window.createTerminal({ name, cwd: projectPath || undefined });
    this._terms.set(key, { terminal, running: false, runId, stepId });
    return terminal;
  }

  /** Kill the interactive terminal for a run's step. Returns true if the terminal was closed. */
  public cancelStep(runId: string | undefined, stepId: string): boolean {
    const key = this._key(runId, stepId);
    const state = this._terms.get(key);
    if (!state) return false;
    if (!state.running) {
      // Launch is mid-flight (awaiting shell integration): flag it so runInTerminal aborts before
      // spawning claude. No live terminal to dispose yet, so report "not closed".
      state.launchAborted = true;
      return false;
    }
    state.terminal.dispose();
    this._disposeState(key);
    return true;
  }

  public dispose(): void {
    while (this._disposables.length) this._disposables.pop()?.dispose();
  }
}
