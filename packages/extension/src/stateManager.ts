import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { FlowRunState } from '@ai-stepflow/core';

export class StateManager {
  constructor(private context?: vscode.ExtensionContext) {}

  /** Resolved lazily so workspace folder changes are always picked up. */
  private get projectPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Gets a local folder for non-repo storage (machine-specific). */
  private async getLocalStorageDir(): Promise<string | undefined> {
    if (!this.context?.storageUri) return undefined;
    const dir = this.context.storageUri.fsPath;
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Lowercase slug: spaces/punctuation → '-', collapsed, trimmed. Empty input → ''. */
  private slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /** Readable run filename base: <flowName-slug>-<runName-slug>, falling back to ids when names are missing. */
  private runFileBase(run: FlowRunState): string {
    const flow = this.slugify(run.flowName || run.flowId) || this.slugify(run.flowId);
    const name = this.slugify(run.runName || '') || this.slugify(run.runId);
    return `${flow}-${name}`;
  }

  public async saveRun(run: FlowRunState): Promise<void> {
    if (!this.projectPath) return;

    const runsDir = path.join(this.projectPath, '.ai-stepflow', 'runs');
    await fs.mkdir(runsDir, { recursive: true });

    const filePath = path.join(runsDir, `${this.runFileBase(run)}.json`);

    // Write atomically: a plain writeFile truncates the target first, so a crash or kill mid-write
    // leaves a 0-byte / partial run file that later fails to load (a silently un-resumable run).
    // Writing to a temp file and renaming makes the swap atomic — the real file is never truncated.
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(run, null, 2), 'utf8');
    await fs.rename(tmpPath, filePath);
  }

  /** Save a generated markdown report inside the repo so it can be shared or committed. */
  public async saveReport(run: FlowRunState, content: string): Promise<string | undefined> {
    if (!this.projectPath) return undefined;
    const reportsDir = path.join(this.projectPath, '.ai-stepflow', 'reports');
    await fs.mkdir(reportsDir, { recursive: true });
    const filePath = path.join(reportsDir, `${this.runFileBase(run)}.md`);
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  /** Delete the persisted run JSON. Reconstructs the slug filename from the run itself. */
  public async deleteRunFile(run: FlowRunState): Promise<void> {
    if (!this.projectPath) return;
    const filePath = path.join(this.projectPath, '.ai-stepflow', 'runs', `${this.runFileBase(run)}.json`);
    try { await fs.unlink(filePath); } catch { /* ignore if not found */ }
  }

  /** Delete the generated markdown report. Reconstructs the slug filename from the run itself. */
  public async deleteReportFile(run: FlowRunState): Promise<void> {
    if (!this.projectPath) return;
    const filePath = path.join(this.projectPath, '.ai-stepflow', 'reports', `${this.runFileBase(run)}.md`);
    try { await fs.unlink(filePath); } catch { /* ignore if not found */ }
  }

  /** Saves an event to a local audit log that is never committed to the repo. */
  public async appendAuditLog(flowId: string, runId: string, stepId: string, event: { timestamp: string; status: string; message?: string }): Promise<void> {
    const dir = await this.getLocalStorageDir();
    if (!dir) return;

    const auditDir = path.join(dir, 'audit-logs');
    await fs.mkdir(auditDir, { recursive: true });

    const logFile = path.join(auditDir, `${flowId}.jsonl`);
    const line = JSON.stringify({ runId, stepId, ...event }) + '\n';
    await fs.appendFile(logFile, line, 'utf8');
  }

  /** Loads all audit log entries for a given flow from local storage. */
  public async loadAuditLog(flowId: string): Promise<any[]> {
    const dir = await this.getLocalStorageDir();
    if (!dir) return [];

    const logFile = path.join(dir, 'audit-logs', `${flowId}.jsonl`);
    try {
      const content = await fs.readFile(logFile, 'utf8');
      return content.trim().split('\n').map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /**
   * Deletes audit log entries for a flow. If runId is provided, only entries for that run are
   * removed; if stepIds is also provided, only entries for those steps within that run are removed
   * (used to reset a single wedged step without wiping the rest of the run's history).
   */
  public async clearAuditLog(flowId: string, runId?: string, stepIds?: string[]): Promise<void> {
    const dir = await this.getLocalStorageDir();
    if (!dir) return;
    const logFile = path.join(dir, 'audit-logs', `${flowId}.jsonl`);

    if (!runId) {
      try {
        await fs.unlink(logFile);
      } catch {
        // Ignore if file doesn't exist
      }
      return;
    }

    const stepFilter = stepIds ? new Set(stepIds) : null;
    try {
      const content = await fs.readFile(logFile, 'utf8');
      const lines = content.trim().split('\n');
      const filtered = lines.filter(line => {
        try {
          const entry = JSON.parse(line);
          if (entry.runId !== runId) return true;
          return stepFilter ? !stepFilter.has(entry.stepId) : false;
        } catch {
          return true;
        }
      });
      if (filtered.length === 0) {
        await fs.unlink(logFile);
      } else {
        await fs.writeFile(logFile, filtered.join('\n') + '\n', 'utf8');
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Most recently modified run that still has unfinished steps, used to resume an
   * in-progress run when the cockpit reopens. Skipping finished runs keeps a stale
   * completed run (or another flow's done run) from being restored over a real one.
   */
  public async loadLatestRun(): Promise<FlowRunState | undefined> {
    if (!this.projectPath) return undefined;

    const runsDir = path.join(this.projectPath, '.ai-stepflow', 'runs');
    let files: string[];
    try {
      files = (await fs.readdir(runsDir)).filter(f => f.endsWith('.json'));
    } catch {
      return undefined;
    }

    let bestUnfinished: { run: FlowRunState; mtimeMs: number } | undefined;
    let bestAny: { run: FlowRunState; mtimeMs: number } | undefined;
    for (const file of files) {
      const filePath = path.join(runsDir, file);
      try {
        const stat = await fs.stat(filePath);
        const content = await fs.readFile(filePath, 'utf8');
        if (!content.trim()) continue; // skip 0-byte / blank files from an interrupted write
        const run = JSON.parse(content) as FlowRunState;
        if (run.isClosed) continue; // Skip finalized runs
        const unfinished = Object.values(run.steps || {}).some(step => step.completionStatus !== 'done');
        if (unfinished && (!bestUnfinished || stat.mtimeMs > bestUnfinished.mtimeMs)) {
          bestUnfinished = { run, mtimeMs: stat.mtimeMs };
        }
        if (!bestAny || stat.mtimeMs > bestAny.mtimeMs) {
          bestAny = { run, mtimeMs: stat.mtimeMs };
        }
      } catch (e) {
        console.error(`Error loading run file ${filePath}:`, e);
      }
    }

    // Prefer an in-progress run so it can be resumed; fall back to the most recent
    // completed run so Cost Analysis remains viewable after a run finishes.
    return (bestUnfinished ?? bestAny)?.run;
  }

  /**
   * Lightweight metadata for every generated run file, newest first. Used by the
   * sidebar to list the files this extension created in the repo without forcing
   * callers to re-derive paths or re-stat each file.
   */
  public async listRunFiles(): Promise<{ flowId: string; runId: string; runName?: string; filePath: string; completedSteps: number; totalSteps: number; mtimeMs: number; isClosed: boolean }[]> {
    if (!this.projectPath) return [];

    const runsDir = path.join(this.projectPath, '.ai-stepflow', 'runs');
    let files: string[];
    try {
      files = (await fs.readdir(runsDir)).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }

    const result: { flowId: string; runId: string; runName?: string; filePath: string; completedSteps: number; totalSteps: number; mtimeMs: number; isClosed: boolean }[] = [];
    for (const file of files) {
      const filePath = path.join(runsDir, file);
      try {
        const stat = await fs.stat(filePath);
        const content = await fs.readFile(filePath, 'utf8');
        if (!content.trim()) continue; // skip 0-byte / blank files from an interrupted write
        const run = JSON.parse(content) as FlowRunState;
        const steps = Object.values(run.steps || {});
        result.push({
          flowId: run.flowId,
          runId: run.runId,
          runName: run.runName,
          filePath,
          completedSteps: steps.filter(step => step.completionStatus === 'done').length,
          totalSteps: steps.length,
          mtimeMs: stat.mtimeMs,
          isClosed: !!run.isClosed
        });
      } catch (e) {
        console.error(`Error reading run file ${filePath}:`, e);
      }
    }

    result.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return result;
  }

  public async loadRuns(): Promise<FlowRunState[]> {
    if (!this.projectPath) return [];

    const runsDir = path.join(this.projectPath, '.ai-stepflow', 'runs');
    let files: string[];
    try {
      files = (await fs.readdir(runsDir)).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }

    const runs: FlowRunState[] = [];
    for (const file of files) {
      try {
        const content = await fs.readFile(path.join(runsDir, file), 'utf8');
        if (!content.trim()) continue; // skip 0-byte / blank files from an interrupted write
        runs.push(JSON.parse(content));
      } catch (e) {
        console.error(`Error loading run file ${file}:`, e);
      }
    }

    return runs;
  }
}
