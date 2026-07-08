import React from 'react';
import { Flow, Agent, Skill } from '@ai-stepflow/core/types';
import { Icon } from '../components/primitives';
import { Tab, ScopeFilter } from '../hooks/appState/types';

/** VS Code command ids the quick-settings panel triggers; must stay in sync with RUNNABLE_COMMANDS in extension/messages.ts. */
export type RunnableCommand =
  | 'ai-stepflow.installDefaults'
  | 'ai-stepflow.refreshAll'
  | 'ai-stepflow.astGraph.rescan'
  | 'ai-stepflow.astGraph.reregisterMcp'
  | 'workbench.action.openSettings';

interface RunSummary {
  flowId: string;
  runId: string;
  runName?: string;
  completedSteps: number;
  totalSteps: number;
  mtimeMs: number;
  isClosed: boolean;
  costUsd?: number;
  tokensUsed?: number;
  taskTimeMs?: number;
  reviewTimeMs?: number;
}

interface RecentWorkspace { path: string; name: string; lastOpenedMs: number }

interface RunTotals { runs: number; completed: number; inProgress: number; costUsd: number; tokensUsed: number; taskTimeMs: number; reviewTimeMs: number }

interface DayPoint { date: string; runs: number; costUsd: number; tokensUsed: number }
type TrendMetric = 'costUsd' | 'tokensUsed' | 'runs';

interface OverviewTabProps {
  flows: Flow[];
  agents: Agent[];
  skills: Skill[];
  runSummaries: RunSummary[];
  connectedMcpServers: string[];
  defaultLibraryInstalled: boolean;
  recentWorkspaces: RecentWorkspace[];
  runTotalsAll: RunTotals;
  runTrendAll: DayPoint[];
  globalPath: string;
  projectPath: string;
  scope: ScopeFilter;
  onScopeChange: (v: ScopeFilter) => void;
  onNavigate: (tab: Tab) => void;
  onConnectMcp: () => void;
  onRunCommand: (command: RunnableCommand) => void;
  onOpenWorkspace: (path: string) => void;
}

const fmtUsd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${n}`);
const fmtDuration = (ms: number) => {
  if (ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};
const fmtAgo = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
};

const Stat: React.FC<{ label: string; value: string; hint?: string; onClick?: () => void }> = ({ label, value, hint, onClick }) => (
  <div className={`ov-stat${onClick ? ' clickable' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined}>
    <div className="ov-stat-value">{value}</div>
    <div className="ov-stat-label">{label}</div>
    {hint && <div className="ov-stat-hint muted small">{hint}</div>}
  </div>
);

const SCOPES: { key: ScopeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'project', label: 'Repo' },
  { key: 'global', label: 'Global' }
];

/** Bucket run summaries into the last 14 UTC days — mirrors StateManager.computeRunStats for the current repo. */
const buildRepoTrend = (runs: { mtimeMs: number; costUsd?: number; tokensUsed?: number }[]): DayPoint[] => {
  const dayMs = 86_400_000;
  const today = Date.now();
  const buckets = new Map<string, DayPoint>();
  for (let i = 13; i >= 0; i--) {
    const date = new Date(today - i * dayMs).toISOString().slice(0, 10);
    buckets.set(date, { date, runs: 0, costUsd: 0, tokensUsed: 0 });
  }
  for (const r of runs) {
    const b = buckets.get(new Date(r.mtimeMs).toISOString().slice(0, 10));
    if (b) { b.runs++; b.costUsd += r.costUsd || 0; b.tokensUsed += r.tokensUsed || 0; }
  }
  return [...buckets.values()];
};

const TREND_METRICS: { key: TrendMetric; label: string }[] = [
  { key: 'costUsd', label: 'Cost' },
  { key: 'tokensUsed', label: 'Tokens' },
  { key: 'runs', label: 'Runs' }
];

const TrendChart: React.FC<{ trend: DayPoint[]; metric: TrendMetric }> = ({ trend, metric }) => {
  const max = Math.max(1, ...trend.map(d => d[metric]));
  const fmt = metric === 'costUsd' ? fmtUsd : metric === 'tokensUsed' ? fmtTokens : (n: number) => `${n}`;
  return (
    <div className="ov-chart">
      {trend.map(d => {
        const v = d[metric];
        return (
          <div key={d.date} className="ov-chart-col" title={`${d.date}\ncost ${fmtUsd(d.costUsd)} · ${fmtTokens(d.tokensUsed)} tokens · ${d.runs} run(s)`}>
            <div className="ov-chart-bar-track">
              <div className="ov-chart-bar" style={{ height: `${Math.round((v / max) * 100)}%` }} />
            </div>
            <div className="ov-chart-x muted">{d.date.slice(5)}</div>
          </div>
        );
      })}
      <div className="ov-chart-max muted small">max {fmt(max)}</div>
    </div>
  );
};

export const OverviewTab: React.FC<OverviewTabProps> = ({
  flows, agents, skills, runSummaries, connectedMcpServers, defaultLibraryInstalled, recentWorkspaces, runTotalsAll, runTrendAll,
  globalPath, projectPath, scope, onScopeChange, onNavigate, onConnectMcp, onRunCommand, onOpenWorkspace
}) => {
  const [trendMetric, setTrendMetric] = React.useState<TrendMetric>('costUsd');
  const isGlobal = (sourcePath: string) => !!globalPath && sourcePath.startsWith(globalPath);
  const inScope = (sourcePath: string) =>
    scope === 'all' ? true : scope === 'global' ? isGlobal(sourcePath) : !isGlobal(sourcePath);

  const fFlows = flows.filter(f => inScope(f.sourcePath));
  const fAgents = agents.filter(a => inScope(a.sourcePath));
  const fSkills = skills.filter(s => inScope(s.sourcePath));
  const splitHint = <T extends { sourcePath: string }>(items: T[]) => {
    if (scope !== 'all') return undefined;
    const g = items.filter(i => isGlobal(i.sourcePath)).length;
    return `${g} global · ${items.length - g} repo`;
  };

  // 'repo' → totals from the current repo's run files; 'all' → cross-repo totals from the host.
  const repoTotals: RunTotals = runSummaries.reduce((t, r) => ({
    runs: t.runs + 1,
    completed: t.completed + (r.totalSteps > 0 && r.completedSteps >= r.totalSteps ? 1 : 0),
    inProgress: t.inProgress + (!r.isClosed && r.completedSteps < r.totalSteps ? 1 : 0),
    costUsd: t.costUsd + (r.costUsd || 0),
    tokensUsed: t.tokensUsed + (r.tokensUsed || 0),
    taskTimeMs: t.taskTimeMs + (r.taskTimeMs || 0),
    reviewTimeMs: t.reviewTimeMs + (r.reviewTimeMs || 0)
  }), { runs: 0, completed: 0, inProgress: 0, costUsd: 0, tokensUsed: 0, taskTimeMs: 0, reviewTimeMs: 0 } as RunTotals);
  const totals = scope === 'all' ? runTotalsAll : repoTotals;
  const runsHint = scope === 'all' ? `across ${recentWorkspaces.length || 1} workspace(s)` : 'in this repo';
  const trend = scope === 'all' ? runTrendAll : buildRepoTrend(runSummaries);

  const gitnexusConnected = connectedMcpServers.some(s => /gitnexus|ast-graph/i.test(s));

  return (
    <div className="page ov-page">
      <div className="page-head">
        <div>
          <h2 className="ov-title">Overview</h2>
          <p className="muted small">{projectPath ? projectPath.split('/').pop() : 'No workspace'} — library &amp; run statistics</p>
        </div>
        <div className="page-head-actions">
          <div className="ov-scope-switch" role="tablist" aria-label="Scope">
            {SCOPES.map(s => (
              <button
                key={s.key}
                className={`ov-scope-btn${scope === s.key ? ' active' : ''}`}
                onClick={() => onScopeChange(s.key)}
              >{s.label}</button>
            ))}
          </div>
          <button className="btn" onClick={() => onRunCommand('ai-stepflow.refreshAll')} title="Reload library and runs">
            <span className="btn-glyph"><Icon.RotateCw size={14} /></span>Refresh
          </button>
        </div>
      </div>

      <section className="ov-section">
        <div className="ov-section-title">Library</div>
        <div className="ov-grid">
          <Stat label="Workflows" value={`${fFlows.length}`} hint={splitHint(flows)} onClick={() => onNavigate('flows')} />
          <Stat label="Agents" value={`${fAgents.length}`} hint={splitHint(agents)} onClick={() => onNavigate('agents')} />
          <Stat label="Skills" value={`${fSkills.length}`} hint={splitHint(skills)} onClick={() => onNavigate('skills')} />
        </div>
      </section>

      <section className="ov-section">
        <div className="ov-section-title">Runs</div>
        {scope === 'global' ? (
          <div className="ov-note muted small">Runs are tracked per repository — switch to “Repo” or “All” to see run statistics.</div>
        ) : (
          <div className="ov-grid">
            <Stat label="Total runs" value={`${totals.runs}`} hint={`${totals.completed} completed · ${totals.inProgress} in progress`} />
            <Stat label="Total cost" value={fmtUsd(totals.costUsd)} hint={runsHint} />
            <Stat label="Tokens" value={fmtTokens(totals.tokensUsed)} hint="input + output + cache" />
            <Stat label="Execution time" value={fmtDuration(totals.taskTimeMs)} hint="steps running" />
            <Stat label="Review time" value={fmtDuration(totals.reviewTimeMs)} hint="human / AI review" />
          </div>
        )}
      </section>

      {scope !== 'global' && (
        <section className="ov-section">
          <div className="ov-section-head">
            <div className="ov-section-title">Trend · last 14 days</div>
            <div className="ov-scope-switch">
              {TREND_METRICS.map(m => (
                <button
                  key={m.key}
                  className={`ov-scope-btn${trendMetric === m.key ? ' active' : ''}`}
                  onClick={() => setTrendMetric(m.key)}
                >{m.label}</button>
              ))}
            </div>
          </div>
          {trend.some(d => d.runs > 0)
            ? <TrendChart trend={trend} metric={trendMetric} />
            : <div className="ov-note muted small">No run activity in the last 14 days.</div>}
        </section>
      )}

      <div className="ov-columns">
      <section className="ov-section">
        <div className="ov-section-title">Recent workspaces</div>
        {recentWorkspaces.length === 0 ? (
          <div className="ov-note muted small">No recent workspaces yet.</div>
        ) : (
          <div className="ov-recents">
            {recentWorkspaces.map(w => {
              const current = !!projectPath && w.path === projectPath;
              return (
                <button
                  key={w.path}
                  className={`ov-recent-row${current ? ' current' : ''}`}
                  disabled={current}
                  title={current ? `${w.path} (current)` : `Open ${w.path}`}
                  onClick={() => !current && onOpenWorkspace(w.path)}
                >
                  <span className="btn-glyph"><Icon.GitBranch size={14} /></span>
                  <span className="ov-recent-name">{w.name}</span>
                  <span className="ov-recent-path muted small mono">{w.path}</span>
                  <span className="ov-recent-meta muted small">{current ? 'current' : fmtAgo(w.lastOpenedMs)}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="ov-section">
        <div className="ov-section-title">Quick settings</div>
        <div className="ov-settings">
          <div className="ov-setting-row">
            <div className="ov-setting-main">
              <div className="ov-setting-name">
                <span className="btn-glyph"><Icon.GitBranch size={14} /></span>MCP servers
              </div>
              <div className="muted small">
                {connectedMcpServers.length
                  ? `${connectedMcpServers.length} connected: ${connectedMcpServers.join(', ')}`
                  : 'No MCP servers connected'}
                {' · '}
                <span className={gitnexusConnected ? 'ov-ok' : 'ov-warn'}>
                  GitNexus/ast-graph {gitnexusConnected ? 'connected' : 'not connected'}
                </span>
              </div>
            </div>
            <button className="btn" onClick={onConnectMcp}>
              <span className="btn-glyph plus"><Icon.Plus size={14} /></span>Connect
            </button>
          </div>

          <div className="ov-setting-row">
            <div className="ov-setting-main">
              <div className="ov-setting-name">
                <span className="btn-glyph"><Icon.Bot size={14} /></span>Default agents &amp; skills library
              </div>
              <div className="muted small">
                <span className={defaultLibraryInstalled ? 'ov-ok' : 'ov-warn'}>
                  {defaultLibraryInstalled ? 'Installed in ~/.claude' : 'Not installed'}
                </span>
                {' · bundled SDLC agents, skills and engineering rules'}
              </div>
            </div>
            <button className="btn" onClick={() => onRunCommand('ai-stepflow.installDefaults')}>
              <span className="btn-glyph"><Icon.Sparkles size={14} /></span>{defaultLibraryInstalled ? 'Repair' : 'Install'}
            </button>
          </div>

          <div className="ov-setting-row">
            <div className="ov-setting-main">
              <div className="ov-setting-name">
                <span className="btn-glyph"><Icon.Zap size={14} /></span>AST graph &amp; run settings
              </div>
              <div className="muted small">Enable/disable AST graph, run timeout, max turns, headless MCP servers</div>
            </div>
            <div className="btn-group">
              <button className="btn" onClick={() => onRunCommand('ai-stepflow.astGraph.rescan')} title="Rescan AST graph">
                <span className="btn-glyph"><Icon.RotateCw size={14} /></span>Rescan
              </button>
              <button className="btn" onClick={() => onRunCommand('workbench.action.openSettings')} title="Open AI StepFlow settings">
                <span className="btn-glyph"><Icon.Settings size={14} /></span>Settings
              </button>
            </div>
          </div>
        </div>
      </section>
      </div>
    </div>
  );
};
