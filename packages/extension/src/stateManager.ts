import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { FlowRunState, AdhocRun, shortRunId } from '@ai-stepflow/core';
import { readInteractiveSessionStats } from './sessionStats.js';

/** Lightweight per-run summary with aggregated metrics, listed for the run picker and Overview stats. */
export interface RunSummary {
  flowId: string;
  runId: string;
  runName?: string;
  filePath: string;
  completedSteps: number;
  /** Steps whose execution failed. */
  failedSteps: number;
  /** Steps that have started but aren't done yet (running or under review). */
  inProgressSteps: number;
  /** True while a step is awaiting review (AI review running or waiting for a human). */
  reviewing: boolean;
  totalSteps: number;
  mtimeMs: number;
  isClosed: boolean;
  /** Sum of every step's cost (USD). */
  costUsd: number;
  /** Sum of every step's token usage. */
  tokensUsed: number;
  /** Sum of per-step execution time (completedAt − startedAt), in ms. */
  taskTimeMs: number;
  /** Sum of per-step review time (reviewCompletedAt − completedAt), in ms. */
  reviewTimeMs: number;
}

/** Run metrics summed across one or more workspaces, for the Overview stats. */
export interface RunTotals {
  runs: number;
  completed: number;
  inProgress: number;
  costUsd: number;
  tokensUsed: number;
  taskTimeMs: number;
  reviewTimeMs: number;
}

/** One day's run activity, for the Overview trend chart and date-range filtering. */
export interface DayPoint {
  /** UTC date, `YYYY-MM-DD`. */
  date: string;
  runs: number;
  completed: number;
  inProgress: number;
  costUsd: number;
  tokensUsed: number;
  taskTimeMs: number;
}

export class StateManager {
  /** Per-file summary cache keyed by path; reused while the file's mtime is unchanged. */
  private runSummaryCache = new Map<string, { mtimeMs: number; summary: RunSummary }>();

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

  /** Absolute path of the ad-hoc run history file in the extension's machine-global storage. */
  private async adhocRunsFile(): Promise<string | undefined> {
    if (!this.context?.globalStorageUri) return undefined;
    const dir = this.context.globalStorageUri.fsPath;
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, 'adhoc-runs.json');
  }

  /** Read the raw ad-hoc run records (newest first). Returns [] on any failure. */
  private async readAdhocRuns(): Promise<AdhocRun[]> {
    const file = await this.adhocRunsFile();
    if (!file) return [];
    try {
      const arr = JSON.parse(await fs.readFile(file, 'utf8'));
      return Array.isArray(arr) ? arr as AdhocRun[] : [];
    } catch { return []; }
  }

  /** Cap on stored ad-hoc records so the history file can't grow without bound. */
  private static readonly ADHOC_CAP = 500;

  /** Persist one ad-hoc run, newest first, capped at {@link ADHOC_CAP}. Metrics are NOT stored. */
  public async saveAdhocRun(run: AdhocRun): Promise<void> {
    const file = await this.adhocRunsFile();
    if (!file) return;
    const runs = [run, ...(await this.readAdhocRuns())].slice(0, StateManager.ADHOC_CAP);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(runs, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  /**
   * List ad-hoc runs for one agent/skill (newest first), each enriched with token/cost/model read
   * lazily from its pinned session `.jsonl`. Missing/rotated session files just leave metrics blank.
   */
  public async listAdhocRuns(kind: 'agent' | 'skill', name: string): Promise<AdhocRun[]> {
    const matches = (await this.readAdhocRuns()).filter(r => r.kind === kind && r.name === name);
    return Promise.all(matches.map(async run => {
      const metrics = await readInteractiveSessionStats(run.projectPath, new Date(run.startedAt), run.sessionId);
      return { ...run, tokensUsed: metrics.tokensUsed, costUsd: metrics.costUsd, modelUsed: metrics.modelUsed };
    }));
  }

  /** Lowercase slug: spaces/punctuation → '-', collapsed, trimmed. Empty input → ''. */
  private slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /**
   * Readable run filename base: `<flowName-slug>-<runName-slug>-<runId-fingerprint>`. The runId
   * fingerprint makes the name unique so two runs of the same flow with the same run name never
   * share a file — matching the per-run output slug ({@link runOutputSlug}). A nameless run already
   * has a unique runId slug, so it gets no extra suffix.
   */
  private runFileBase(run: FlowRunState): string {
    const flow = this.slugify(run.flowName || run.flowId) || this.slugify(run.flowId);
    const named = this.slugify(run.runName || '');
    const name = named ? `${named}-${shortRunId(run.runId)}` : this.slugify(run.runId);
    return `${flow}-${name}`;
  }

  /** Pre-fingerprint filename base, used only as a READ/delete fallback for runs written before the runId suffix. '' when it equals {@link runFileBase}. */
  private legacyRunFileBase(run: FlowRunState): string {
    const flow = this.slugify(run.flowName || run.flowId) || this.slugify(run.flowId);
    const name = this.slugify(run.runName || '') || this.slugify(run.runId);
    const legacy = `${flow}-${name}`;
    return legacy === this.runFileBase(run) ? '' : legacy;
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

  /** Save a per-step AI review report inside the repo. Returns the absolute path written. */
  public async saveReviewReport(run: FlowRunState, stepId: string, content: string): Promise<string | undefined> {
    if (!this.projectPath) return undefined;
    const dir = path.join(this.projectPath, '.ai-stepflow', 'reports', 'reviews');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${this.runFileBase(run)}-${this.slugify(stepId)}.md`);
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  /** Delete the persisted run JSON. Reconstructs the slug filename from the run itself. */
  public async deleteRunFile(run: FlowRunState): Promise<void> {
    if (!this.projectPath) return;
    const dir = path.join(this.projectPath, '.ai-stepflow', 'runs');
    for (const base of [this.runFileBase(run), this.legacyRunFileBase(run)]) {
      if (!base) continue;
      try { await fs.unlink(path.join(dir, `${base}.json`)); } catch { /* ignore if not found */ }
    }
  }

  /** Delete the generated markdown report. Reconstructs the slug filename from the run itself. */
  public async deleteReportFile(run: FlowRunState): Promise<void> {
    if (!this.projectPath) return;
    const dir = path.join(this.projectPath, '.ai-stepflow', 'reports');
    for (const base of [this.runFileBase(run), this.legacyRunFileBase(run)]) {
      if (!base) continue;
      try { await fs.unlink(path.join(dir, `${base}.md`)); } catch { /* ignore if not found */ }
    }
  }

  /**
   * Delete the per-step AI review reports (written by {@link saveReviewReport} when a step is
   * approved or rejected) for the given steps of a run. Exact per-step filenames — not a prefix glob — so a run
   * whose slug is a prefix of another's never has its reports deleted by mistake. No-op if absent.
   */
  public async deleteReviewReports(run: FlowRunState, stepIds: string[]): Promise<void> {
    if (!this.projectPath) return;
    const dir = path.join(this.projectPath, '.ai-stepflow', 'reports', 'reviews');
    const bases = [this.runFileBase(run), this.legacyRunFileBase(run)].filter(Boolean);
    await Promise.all(stepIds.flatMap(stepId => bases.map(async base => {
      const filePath = path.join(dir, `${base}-${this.slugify(stepId)}.md`);
      try { await fs.unlink(filePath); } catch { /* ignore if not found */ }
    })));
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
  public async listRunFiles(): Promise<RunSummary[]> {
    if (!this.projectPath) return [];
    return this.readRunsFromDir(path.join(this.projectPath, '.ai-stepflow', 'runs'));
  }

  /** Read every run file under one `.ai-stepflow/runs` dir into summaries with aggregated metrics. Missing/unreadable dir → []. */
  private async readRunsFromDir(runsDir: string): Promise<RunSummary[]> {
    let files: string[];
    try {
      files = (await fs.readdir(runsDir)).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }

    const spanMs = (from?: string, to?: string) => {
      if (!from || !to) return 0;
      const ms = new Date(to).getTime() - new Date(from).getTime();
      return Number.isFinite(ms) && ms > 0 ? ms : 0;
    };

    const result: RunSummary[] = [];
    for (const file of files) {
      const filePath = path.join(runsDir, file);
      try {
        const stat = await fs.stat(filePath);
        // Cache hit: an unchanged file (same mtime) reuses its parsed summary, skipping the
        // expensive readFile + JSON.parse. Historical runs never change, so this is the common path.
        const cached = this.runSummaryCache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs) {
          result.push(cached.summary);
          continue;
        }
        const content = await fs.readFile(filePath, 'utf8');
        if (!content.trim()) continue; // skip 0-byte / blank files from an interrupted write
        const run = JSON.parse(content) as FlowRunState;
        const steps = Object.values(run.steps || {});
        // Aggregate metrics from the steps we already parsed — no extra I/O.
        let costUsd = 0, tokensUsed = 0, taskTimeMs = 0, reviewTimeMs = 0;
        for (const step of steps) {
          costUsd += step.costUsd ?? 0;
          tokensUsed += step.tokensUsed ?? 0;
          taskTimeMs += spanMs(step.startedAt, step.completedAt);
          reviewTimeMs += spanMs(step.completedAt, step.reviewCompletedAt);
        }
        const summary: RunSummary = {
          flowId: run.flowId,
          runId: run.runId,
          runName: run.runName,
          filePath,
          completedSteps: steps.filter(step => step.completionStatus === 'done').length,
          failedSteps: steps.filter(step => step.executionStatus === 'failed').length,
          inProgressSteps: steps.filter(step => step.executionStatus === 'running' || step.reviewStatus === 'ai_review_running' || step.reviewStatus === 'waiting_human').length,
          reviewing: steps.some(step => step.reviewStatus === 'ai_review_running' || step.reviewStatus === 'waiting_human'),
          totalSteps: steps.length,
          mtimeMs: stat.mtimeMs,
          isClosed: !!run.isClosed,
          costUsd,
          tokensUsed,
          taskTimeMs,
          reviewTimeMs
        };
        this.runSummaryCache.set(filePath, { mtimeMs: stat.mtimeMs, summary });
        result.push(summary);
      } catch (e) {
        console.error(`Error reading run file ${filePath}:`, e);
      }
    }

    result.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return result;
  }

  /**
   * Sum run metrics across many workspace roots (each `<root>/.ai-stepflow/runs`), deduped,
   * plus a daily trend for the last {@link trendDays} days. Used for the Overview "All" scope.
   */
  public async computeRunStats(workspaceRoots: string[], trendDays = 90): Promise<{ totals: RunTotals; trend: DayPoint[] }> {
    const totals: RunTotals = { runs: 0, completed: 0, inProgress: 0, costUsd: 0, tokensUsed: 0, taskTimeMs: 0, reviewTimeMs: 0 };
    // Pre-seed the last `trendDays` day buckets (oldest → newest) so the chart has a stable x-axis
    // and the webview can sum any date sub-range client-side.
    const dayMs = 86_400_000;
    const today = Date.now();
    const buckets = new Map<string, DayPoint>();
    for (let i = trendDays - 1; i >= 0; i--) {
      const date = new Date(today - i * dayMs).toISOString().slice(0, 10);
      buckets.set(date, { date, runs: 0, completed: 0, inProgress: 0, costUsd: 0, tokensUsed: 0, taskTimeMs: 0 });
    }

    const roots = [...new Set(workspaceRoots.filter(Boolean))];
    for (const root of roots) {
      const runs = await this.readRunsFromDir(path.join(root, '.ai-stepflow', 'runs'));
      for (const r of runs) {
        const completed = r.totalSteps > 0 && r.completedSteps >= r.totalSteps;
        const inProgress = !completed && !r.isClosed;
        totals.runs++;
        if (completed) totals.completed++;
        else if (!r.isClosed) totals.inProgress++;
        totals.costUsd += r.costUsd;
        totals.tokensUsed += r.tokensUsed;
        totals.taskTimeMs += r.taskTimeMs;
        totals.reviewTimeMs += r.reviewTimeMs;

        const day = new Date(r.mtimeMs).toISOString().slice(0, 10);
        const bucket = buckets.get(day);
        if (bucket) {
          bucket.runs++;
          if (completed) bucket.completed++;
          if (inProgress) bucket.inProgress++;
          bucket.costUsd += r.costUsd;
          bucket.tokensUsed += r.tokensUsed;
          bucket.taskTimeMs += r.taskTimeMs;
        }
      }
    }
    return { totals, trend: [...buckets.values()] };
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
