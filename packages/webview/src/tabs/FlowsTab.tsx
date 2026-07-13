import React, { useState } from 'react';
import { Flow, FlowRunState, Agent, Skill } from '@ai-stepflow/core/types';
import { Icon } from '../components/primitives';
import { EmptyState } from '../components/ResourceCard';
import { ScopeFilter, SaveScope, ViewFilter, SortOrder, UnifiedFilterPanel } from '../components/ScopeControls';
import { FlowBoard } from './FlowBoard';
import { useScopeFilter } from '../hooks/useScopeFilter';
import { useViewFilter } from '../hooks/useViewFilter';
import { useSortOrder } from '../hooks/useSortOrder';

const fmtUsd = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${n}`);
const fmtDuration = (ms: number) => {
  if (ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

/** Tiny inline line chart for the run-stat cards. */
const Sparkline: React.FC<{ data: number[]; color: string }> = ({ data, color }) => {
  const w = 76, h = 26;
  const max = Math.max(1, ...data);
  const n = data.length;
  const pts = data.map((v, i) => `${n <= 1 ? w : (i / (n - 1)) * w},${(h - 1) - (v / max) * (h - 2)}`).join(' ');
  return (
    <svg className="flow-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

interface FlowsTabProps {
  flows: Flow[];
  agents: Agent[];
  skills: Skill[];
  auditLogs: Record<string, any[]>;
  runSummaries: { flowId: string; runId: string; runName?: string; completedSteps: number; totalSteps: number; mtimeMs: number; isClosed: boolean; costUsd?: number; tokensUsed?: number; taskTimeMs?: number; reviewTimeMs?: number }[];
  activeFlow: Flow | null;
  runState: FlowRunState | null;
  runnerVisible: boolean;
  activeStepId: string | null;
  completedSteps: number;
  activeProgress: number;
  commandCopied: boolean;
  globalPath: string;
  projectPath: string;
  onRun: (flow: Flow) => void;
  onEdit: (flow: Flow) => void;
  onDetail: (flow: Flow) => void;
  onNew: (flow: Flow, scope: SaveScope) => void;
  onBoardStepEditor: (flow: Flow, index: number) => void;
  onBoardStepAdder: (flow: Flow) => void;
  onRemoveStep: (flow: Flow, index: number) => void;
  onSetActiveStep: (id: string) => void;
  onRunStep: (stepId: string, description: string) => void;
  onOpenFile: (path: string) => void;
  onCopyCommand: () => void;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
  initialFilter: ScopeFilter;
  onScopeFilterChange: (v: ScopeFilter) => void;
  initialViewFilter: ViewFilter;
  onViewFilterChange: (v: ViewFilter) => void;
  initialSortOrder: SortOrder;
  onSortOrderChange: (v: SortOrder) => void;
}

export const FlowsTab: React.FC<FlowsTabProps> = ({
  flows,
  auditLogs,
  runSummaries,
  activeFlow,
  runState,
  runnerVisible,
  activeStepId,
  completedSteps,
  activeProgress,
  commandCopied,
  globalPath,
  projectPath,
  onRun,
  onEdit,
  onDetail,
  onNew,
  onBoardStepEditor,
  onBoardStepAdder,
  onRemoveStep,
  onSetActiveStep,
  onRunStep,
  onOpenFile,
  onCopyCommand,
  outputEndRef,
  initialFilter,
  onScopeFilterChange,
  initialViewFilter,
  onViewFilterChange,
  initialSortOrder,
  onSortOrderChange,
}) => {
  const [filter, setFilter] = useScopeFilter(initialFilter, onScopeFilterChange);
  const [viewFilter, setViewFilter] = useViewFilter(initialViewFilter, onViewFilterChange);
  const [sortOrder, setSortOrder] = useSortOrder(initialSortOrder, onSortOrderChange);
  const [search, setSearch] = useState('');

  const getItemScope = (sourcePath: string): SaveScope => {
    if (globalPath && sourcePath.startsWith(globalPath)) return 'global';
    return 'project';
  };

  const matchesScopeFilter = (sourcePath: string) =>
    filter === 'all' || getItemScope(sourcePath) === filter;

  // Per-flow activity: is any run live, and when did it last run.
  const runMeta = React.useMemo(() => {
    const m = new Map<string, { running: boolean; lastRun: number }>();
    for (const r of runSummaries) {
      const cur = m.get(r.flowId) ?? { running: false, lastRun: 0 };
      const isRunning = !r.isClosed && r.completedSteps < r.totalSteps;
      m.set(r.flowId, { running: cur.running || isRunning, lastRun: Math.max(cur.lastRun, r.mtimeMs) });
    }
    return m;
  }, [runSummaries]);
  const metaOf = (id: string) => runMeta.get(id) ?? { running: false, lastRun: 0 };

  const q = search.trim().toLowerCase();
  const visibleFlows = flows
    .filter(flow => matchesScopeFilter(flow.sourcePath))
    .filter(flow =>
      !q ||
      flow.name.toLowerCase().includes(q) ||
      (flow.description ?? '').toLowerCase().includes(q)
    )
    .sort((a, b) => {
      if (sortOrder === 'asc' || sortOrder === 'desc')
        return sortOrder === 'desc' ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name);
      const ma = metaOf(a.id), mb = metaOf(b.id);
      if (sortOrder === 'oldest')
        return (ma.lastRun || Infinity) - (mb.lastRun || Infinity) || a.name.localeCompare(b.name);
      // 'activity' (default) pins live runs on top; 'newest' skips that.
      if (sortOrder === 'activity' && ma.running !== mb.running) return ma.running ? -1 : 1;
      return mb.lastRun - ma.lastRun || a.name.localeCompare(b.name);
    });

  // ── Run stats for the header cards (this repo's run summaries) ──
  const DAY = 86_400_000;
  const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const todayStart = startOfDay(Date.now());
  const inDay = (t: number, start: number) => t >= start && t < start + DAY;
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

  const activeRuns = runSummaries.filter(r => !r.isClosed && r.completedSteps < r.totalSteps).length;
  const runsToday = runSummaries.filter(r => inDay(r.mtimeMs, todayStart));
  const tokensToday = sum(runsToday.map(r => r.tokensUsed || 0));
  const tokensYest = sum(runSummaries.filter(r => inDay(r.mtimeMs, todayStart - DAY)).map(r => r.tokensUsed || 0));
  const costToday = sum(runsToday.map(r => r.costUsd || 0));
  const avgBase = runsToday.length ? runsToday : runSummaries;
  const avgTaskMs = avgBase.length ? sum(avgBase.map(r => r.taskTimeMs || 0)) / avgBase.length : 0;
  const avgReviewMs = avgBase.length ? sum(avgBase.map(r => r.reviewTimeMs || 0)) / avgBase.length : 0;
  const tokenDelta = tokensYest > 0 ? Math.round(((tokensToday - tokensYest) / tokensYest) * 100) : null;

  type Run = (typeof runSummaries)[number];
  const series = (pick: (r: Run) => number) => {
    const days = 14;
    const arr = new Array<number>(days).fill(0);
    for (const r of runSummaries) {
      const idx = Math.round((todayStart - startOfDay(r.mtimeMs)) / DAY);
      if (idx >= 0 && idx < days) arr[days - 1 - idx] += pick(r);
    }
    return arr;
  };

  const SCOPES: [ScopeFilter, string][] = [['all', 'All'], ['project', 'Repo'], ['global', 'Global']];

  return (
    <div className="page">
      <div className="page-head">
        <h2>Workflows</h2>
        <div className="page-head-actions">
          <div className="page-search">
            <span className="page-search-icon"><Icon.Search size={14} /></span>
            <input
              className="page-search-input"
              type="text"
              placeholder="Search workflows…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="ov-scope-switch" role="tablist" aria-label="Scope">
            {SCOPES.map(([v, label]) => (
              <button
                key={v}
                className={`ov-scope-btn${filter === v ? ' active' : ''}`}
                onClick={() => setFilter(v)}
              >{label}</button>
            ))}
          </div>
          <UnifiedFilterPanel
            scope={filter}
            view={viewFilter}
            sort={sortOrder}
            showBuiltIn={false}
            onApply={(s, v, o) => { setFilter(s); setViewFilter(v); setSortOrder(o); }}
          />
          <button
            className="btn primary"
            onClick={() => {
              onNew(
                { id: `flow-${Date.now()}`, name: '', description: '', inputs: {}, steps: [], sourcePath: '' },
                filter === 'global' ? 'global' : 'project'
              );
            }}
          >
            <span className="btn-glyph plus"><Icon.Plus size={14} /></span>New Flow
          </button>
        </div>
      </div>

      <div className="flow-stats">
        <div className="flow-stat">
          <div className="flow-stat-label">Active runs</div>
          <div className="flow-stat-value">{activeRuns}<span className="sub">/ {flows.length} flows</span></div>
          <div className="flow-stat-foot">
            <span className="muted small">{activeRuns === 0 ? 'none running' : 'running now'}</span>
            <Sparkline data={series(() => 1)} color="var(--success)" />
          </div>
        </div>
        <div className="flow-stat">
          <div className="flow-stat-label">Tokens (today)</div>
          <div className="flow-stat-value">{fmtTokens(tokensToday)}</div>
          <div className="flow-stat-foot">
            <span className="muted small">{tokenDelta === null ? '—' : `${tokenDelta >= 0 ? '▲' : '▼'} ${Math.abs(tokenDelta)}% vs yesterday`}</span>
            <Sparkline data={series(r => r.tokensUsed || 0)} color="var(--running)" />
          </div>
        </div>
        <div className="flow-stat">
          <div className="flow-stat-label">Cost (today)</div>
          <div className="flow-stat-value">{fmtUsd(costToday)}</div>
          <div className="flow-stat-foot">
            <span className="muted small">{runsToday.length} run{runsToday.length === 1 ? '' : 's'} today</span>
            <Sparkline data={series(r => r.costUsd || 0)} color="var(--muted)" />
          </div>
        </div>
        <div className="flow-stat">
          <div className="flow-stat-label">Avg run time</div>
          <div className="flow-stat-value">{fmtDuration(avgTaskMs)}</div>
          <div className="flow-stat-foot">
            <span className="muted small">{avgReviewMs > 0 ? `+ ${fmtDuration(avgReviewMs)} review` : (runsToday.length ? 'today' : 'all runs')}</span>
            <Sparkline data={series(r => r.taskTimeMs || 0)} color="var(--warn)" />
          </div>
        </div>
      </div>

      {visibleFlows.length === 0 ? (
        <EmptyState
          title="No workflows found"
          text={q ? `No workflows match "${search}"` : 'Create a new multi-step flow to automate your tasks.'}
          icon={<Icon.GitBranch size={24} />}
          action={!q ? (
            <button
              className="btn primary"
              onClick={() => onNew(
                { id: `flow-${Date.now()}`, name: '', description: '', inputs: {}, steps: [], sourcePath: '' },
                filter === 'global' ? 'global' : 'project'
              )}
            >
              <span className="btn-glyph plus"><Icon.Plus size={14} /></span>New Flow
            </button>
          ) : undefined}
        />
      ) : (
        <div className="dwrap scroll-x">
          <table className="dtable">
            <thead><tr>
              <th style={{ width: '10%' }}>Status</th><th style={{ width: '37%' }}>Name</th>
              <th style={{ width: '12%' }}>Runs</th><th style={{ width: '10%' }}>Scope</th>
              <th style={{ width: '12%' }}>Steps</th><th style={{ width: '19%' }} />
            </tr></thead>
          {visibleFlows.map(flow => (
            <FlowBoard
              key={flow.id}
              flow={flow}
              scopeBadge={<span className="badge scope">{getItemScope(flow.sourcePath) === 'global' ? 'global' : 'repo'}</span>}
              activeFlow={activeFlow}
              runState={runState}
              auditLogs={auditLogs}
              runSummaries={runSummaries.filter(s => s.flowId === flow.id)}
              runnerVisible={runnerVisible}
              activeStepId={activeStepId}
              completedSteps={completedSteps}
              activeProgress={activeProgress}
              commandCopied={commandCopied}
              globalPath={globalPath}
              projectPath={projectPath}
              onRun={onRun}
              onEdit={onEdit}
              onDetail={onDetail}
              onBoardStepEditor={onBoardStepEditor}
              onBoardStepAdder={onBoardStepAdder}
              onRemoveStep={onRemoveStep}
              onSetActiveStep={onSetActiveStep}
              onRunStep={onRunStep}
              onOpenFile={onOpenFile}
              onCopyCommand={onCopyCommand}
              outputEndRef={outputEndRef}
            />
          ))}
          </table>
        </div>
      )}
    </div>
  );
};

export default FlowsTab;
