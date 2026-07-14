import React from 'react';
import { Flow, Agent, Skill } from '@ai-stepflow/core/types';
import { Icon } from '../components/primitives';
import { Tab, ScopeFilter } from '../hooks/appState/types';

/** VS Code command ids the quick-settings panel triggers; must stay in sync with RUNNABLE_COMMANDS in extension/messages.ts. */
export type RunnableCommand =
  | 'ai-stepflow.installDefaults'
  | 'ai-stepflow.refreshAll'
  | 'ai-stepflow.astGraph.install'
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

interface DayPoint { date: string; runs: number; completed: number; inProgress: number; costUsd: number; tokensUsed: number; taskTimeMs: number }
type TrendMetric = 'costUsd' | 'tokensUsed' | 'runs';
type RangeKey = 'all' | '1d' | '7d' | '14d' | '1m';

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
  onRevealPath: (path: string) => void;
  onConnectGitnexus: () => void;
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

const TREND_WINDOW_DAYS = 90;

/** Bucket the current repo's run summaries into the last {@link TREND_WINDOW_DAYS} UTC days — mirrors StateManager.computeRunStats. */
const buildRepoSeries = (runs: RunSummary[]): DayPoint[] => {
  const dayMs = 86_400_000;
  const today = Date.now();
  const buckets = new Map<string, DayPoint>();
  for (let i = TREND_WINDOW_DAYS - 1; i >= 0; i--) {
    const date = new Date(today - i * dayMs).toISOString().slice(0, 10);
    buckets.set(date, { date, runs: 0, completed: 0, inProgress: 0, costUsd: 0, tokensUsed: 0, taskTimeMs: 0 });
  }
  for (const r of runs) {
    const b = buckets.get(new Date(r.mtimeMs).toISOString().slice(0, 10));
    if (!b) continue;
    const completed = r.totalSteps > 0 && r.completedSteps >= r.totalSteps;
    b.runs++;
    if (completed) b.completed++;
    else if (!r.isClosed) b.inProgress++;
    b.costUsd += r.costUsd || 0;
    b.tokensUsed += r.tokensUsed || 0;
    b.taskTimeMs += r.taskTimeMs || 0;
  }
  return [...buckets.values()];
};

const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: 'all', label: 'All', days: 0 },
  { key: '1d', label: '1D', days: 1 },
  { key: '7d', label: '7D', days: 7 },
  { key: '14d', label: '14D', days: 14 },
  { key: '1m', label: '1M', days: 30 }
];

/** UTC `YYYY-MM-DD`, `offsetDays` before today. */
const dayStr = (offsetDays = 0) => new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);

const emptyTotals: RunTotals = { runs: 0, completed: 0, inProgress: 0, costUsd: 0, tokensUsed: 0, taskTimeMs: 0, reviewTimeMs: 0 };
const sumDays = (days: DayPoint[]): RunTotals => days.reduce((t, d) => ({
  runs: t.runs + d.runs,
  completed: t.completed + d.completed,
  inProgress: t.inProgress + d.inProgress,
  costUsd: t.costUsd + d.costUsd,
  tokensUsed: t.tokensUsed + d.tokensUsed,
  taskTimeMs: t.taskTimeMs + d.taskTimeMs,
  reviewTimeMs: 0
}), { ...emptyTotals });

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
  globalPath, projectPath, scope, onScopeChange, onNavigate, onConnectMcp, onRunCommand, onOpenWorkspace, onRevealPath, onConnectGitnexus
}) => {
  const [trendMetric, setTrendMetric] = React.useState<TrendMetric>('costUsd');
  const [recentQuery, setRecentQuery] = React.useState('');
  const [range, setRange] = React.useState<RangeKey>('1m');
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

  // Enriched daily series for the current scope; the selected range sums a sub-window of it.
  const series = scope === 'all' ? runTrendAll : buildRepoSeries(runSummaries);
  const preset = RANGES.find(r => r.key === range);
  let from: string | null = null, to: string | null = null;
  if (range !== 'all') {
    from = dayStr((preset?.days ?? 1) - 1);
    to = dayStr(0);
  }
  const rangedDays = from === null || to === null ? series : series.filter(d => d.date >= from! && d.date <= to!);

  const allTimeTotals = scope === 'all' ? runTotalsAll : repoTotals;
  const totals = range === 'all' ? allTimeTotals : sumDays(rangedDays);
  // All-time keeps the compact 14-bar chart; a dated range shows exactly its window.
  const trend = range === 'all' ? series.slice(-14) : rangedDays;
  const runsHint = scope === 'all' ? `across ${recentWorkspaces.length || 1} workspace(s)` : 'in this repo';
  const rangeLabel = range === 'all' ? 'all time'
    : range === '1d' ? 'today'
    : `last ${preset?.days} days`;
  // The 'all' chart still shows the last 14 daily bars, so label the Trend section by what it actually plots.
  const trendLabel = range === 'all' ? 'last 14 days' : rangeLabel;

  const gitnexusConnected = connectedMcpServers.some(s => /gitnexus|ast-graph/i.test(s));
  // The Connect action registers the GitNexus MCP specifically — gate it on gitnexus alone (NOT
  // ast-graph) so it stays consistent with the sidebar's gitnexus-only row gating.
  const gitnexusMcpConnected = connectedMcpServers.some(s => /gitnexus/i.test(s));
  // AST graph is installed once its MCP server is registered; before that, offer an Install button.
  const astConnected = connectedMcpServers.some(s => /ast-graph/i.test(s));

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
        <div className="ov-section-head">
          <div className="ov-section-title">Runs<span className="muted small"> · {rangeLabel}</span></div>
          {scope !== 'global' && (
            <div className="ov-filter">
              <div className="ov-scope-switch">
                {RANGES.map(r => (
                  <button
                    key={r.key}
                    className={`ov-scope-btn${range === r.key ? ' active' : ''}`}
                    onClick={() => setRange(r.key)}
                  >{r.label}</button>
                ))}
              </div>
            </div>
          )}
        </div>
        {scope === 'global' ? (
          <div className="ov-note muted small">Runs are tracked per repository — switch to “Repo” or “All” to see run statistics.</div>
        ) : (
          <div className="ov-grid">
            <Stat label="Total runs" value={`${totals.runs}`} hint={`${totals.completed} completed · ${totals.inProgress} in progress`} />
            <Stat label="Total cost" value={fmtUsd(totals.costUsd)} hint={runsHint} />
            <Stat label="Tokens" value={fmtTokens(totals.tokensUsed)} hint="input + output + cache" />
            <Stat label="Execution time" value={fmtDuration(totals.taskTimeMs)} hint="steps running" />
          </div>
        )}
      </section>

      {scope !== 'global' && (
        <section className="ov-section">
          <div className="ov-section-head">
            <div className="ov-section-title">Trend · {trendLabel}</div>
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
            : <div className="ov-note muted small">No run activity in {trendLabel}.</div>}
        </section>
      )}

      <div className="ov-columns">
      <section className="ov-section">
        <div className="ov-section-title">Recent workspaces</div>
        {recentWorkspaces.length === 0 ? (
          <div className="ov-note muted small">No recent workspaces yet.</div>
        ) : (() => {
          const q = recentQuery.trim().toLowerCase();
          const filtered = q
            ? recentWorkspaces.filter(w => w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q))
            : recentWorkspaces;
          return (
          <>
            <input
              className="ov-recent-search"
              type="text"
              placeholder="Search workspaces…"
              value={recentQuery}
              onChange={e => setRecentQuery(e.target.value)}
            />
            {filtered.length === 0 ? (
              <div className="ov-note muted small">No workspaces match “{recentQuery}”.</div>
            ) : (
          <div className="ov-recents">
            {filtered.map(w => {
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
          </>
          );
        })()}
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

          {!gitnexusMcpConnected && (
            <div className="ov-setting-row">
              <div className="ov-setting-main">
                <div className="ov-setting-name">
                  <span className="btn-glyph"><Icon.Zap size={14} /></span>GitNexus code intelligence
                </div>
                <div className="muted small">
                  <span className="ov-warn">Not connected</span>
                  {' · registers the GitNexus MCP server (runs via npx — no install needed). Connect once, then Analyze repos from the sidebar.'}
                </div>
              </div>
              <button className="btn primary" onClick={onConnectGitnexus} title="Run: claude mcp add gitnexus -- npx gitnexus mcp">
                <span className="btn-glyph"><Icon.Zap size={14} /></span>Connect
              </button>
            </div>
          )}

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
            <div className="btn-group">
              <button className="btn" onClick={() => onRevealPath(globalPath)} disabled={!globalPath} title="Open ~/.claude in file explorer">
                <span className="btn-glyph"><Icon.FolderOpen size={14} /></span>Open folder
              </button>
              <button className="btn" onClick={() => onRunCommand('ai-stepflow.installDefaults')}>
                <span className="btn-glyph"><Icon.Sparkles size={14} /></span>{defaultLibraryInstalled ? 'Repair' : 'Install'}
              </button>
            </div>
          </div>

          <div className="ov-setting-row">
            <div className="ov-setting-main">
              <div className="ov-setting-name">
                <span className="btn-glyph"><Icon.Zap size={14} /></span>AST graph &amp; run settings
              </div>
              <div className="muted small">
                <span className={astConnected ? 'ov-ok' : 'ov-warn'}>
                  {astConnected ? 'Installed' : 'Not installed'}
                </span>
                {' · downloads the ast-graph CLI, indexes this workspace, and exposes it as an MCP server'}
              </div>
            </div>
            <div className="btn-group">
              {!astConnected ? (
                <button className="btn primary" onClick={() => onRunCommand('ai-stepflow.astGraph.install')} title="Install AST graph (download CLI + index workspace)">
                  <span className="btn-glyph"><Icon.Download size={14} /></span>Install
                </button>
              ) : (
                <button className="btn" onClick={() => onRunCommand('ai-stepflow.astGraph.rescan')} title="Rescan AST graph">
                  <span className="btn-glyph"><Icon.RotateCw size={14} /></span>Rescan
                </button>
              )}
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
