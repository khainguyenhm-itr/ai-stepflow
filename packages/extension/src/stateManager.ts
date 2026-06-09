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

  public async saveRun(run: FlowRunState): Promise<void> {
    if (!this.projectPath) return;

    const runsDir = path.join(this.projectPath, '.claude-flow', 'runs');
    await fs.mkdir(runsDir, { recursive: true });

    const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '-');
    const filePath = path.join(runsDir, `${safe(run.flowId)}-${safe(run.runId)}.json`);

    await fs.writeFile(filePath, JSON.stringify(run, null, 2), 'utf8');
  }

  /** Save a generated markdown report inside the repo so it can be shared or committed. */
  public async saveReport(flowId: string, runId: string, content: string): Promise<string | undefined> {
    if (!this.projectPath) return undefined;
    const reportsDir = path.join(this.projectPath, '.claude-flow', 'reports');
    await fs.mkdir(reportsDir, { recursive: true });
    const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '-');
    const filePath = path.join(reportsDir, `${safe(flowId)}-${safe(runId)}.md`);
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
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
   * Most recently modified run that still has unfinished steps, used to resume an
   * in-progress run when the cockpit reopens. Skipping finished runs keeps a stale
   * completed run (or another flow's done run) from being restored over a real one.
   */
  public async loadLatestRun(): Promise<FlowRunState | undefined> {
    if (!this.projectPath) return undefined;

    const runsDir = path.join(this.projectPath, '.claude-flow', 'runs');
    let files: string[];
    try {
      files = (await fs.readdir(runsDir)).filter(f => f.endsWith('.json'));
    } catch {
      return undefined;
    }

    let best: { run: FlowRunState; mtimeMs: number } | undefined;
    for (const file of files) {
      const filePath = path.join(runsDir, file);
      try {
        const stat = await fs.stat(filePath);
        const run = JSON.parse(await fs.readFile(filePath, 'utf8')) as FlowRunState;
        const unfinished = Object.values(run.steps || {}).some(step => step.completionStatus !== 'done');
        if (!unfinished) continue;
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = { run, mtimeMs: stat.mtimeMs };
        }
      } catch (e) {
        console.error(`Error loading run file ${filePath}:`, e);
      }
    }

    return best?.run;
  }

  /**
   * Lightweight metadata for every generated run file, newest first. Used by the
   * sidebar to list the files this extension created in the repo without forcing
   * callers to re-derive paths or re-stat each file.
   */
  public async listRunFiles(): Promise<{ flowId: string; runId: string; filePath: string; completedSteps: number; totalSteps: number; mtimeMs: number }[]> {
    if (!this.projectPath) return [];

    const runsDir = path.join(this.projectPath, '.claude-flow', 'runs');
    let files: string[];
    try {
      files = (await fs.readdir(runsDir)).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }

    const result: { flowId: string; runId: string; filePath: string; completedSteps: number; totalSteps: number; mtimeMs: number }[] = [];
    for (const file of files) {
      const filePath = path.join(runsDir, file);
      try {
        const stat = await fs.stat(filePath);
        const run = JSON.parse(await fs.readFile(filePath, 'utf8')) as FlowRunState;
        const steps = Object.values(run.steps || {});
        result.push({
          flowId: run.flowId,
          runId: run.runId,
          filePath,
          completedSteps: steps.filter(step => step.completionStatus === 'done').length,
          totalSteps: steps.length,
          mtimeMs: stat.mtimeMs
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

    const runsDir = path.join(this.projectPath, '.claude-flow', 'runs');
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
        runs.push(JSON.parse(content));
      } catch (e) {
        console.error(`Error loading run file ${file}:`, e);
      }
    }

    return runs;
  }
}
