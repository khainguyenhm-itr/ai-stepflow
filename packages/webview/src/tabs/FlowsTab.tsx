import React, { useState } from 'react';
import { Flow, FlowRunState, Agent, Skill } from '@ai-stepflow/core/types';
import { Icon } from '../components/primitives';
import { EmptyState } from '../components/ResourceCard';
import { ScopeFilter, SaveScope, ViewFilter, SortOrder, UnifiedFilterPanel } from '../components/ScopeControls';
import { FlowBoard } from './FlowBoard';
import { useScopeFilter } from '../hooks/useScopeFilter';
import { useViewFilter } from '../hooks/useViewFilter';
import { useSortOrder } from '../hooks/useSortOrder';

interface FlowsTabProps {
  flows: Flow[];
  agents: Agent[];
  skills: Skill[];
  auditLogs: Record<string, any[]>;
  runSummaries: { flowId: string; runId: string; runName?: string; completedSteps: number; totalSteps: number; mtimeMs: number; isClosed: boolean }[];
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
  isBookmarked: (flow: Flow) => boolean;
  onToggleBookmark: (flow: Flow) => void;
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
  isBookmarked,
  onToggleBookmark,
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

  const q = search.trim().toLowerCase();
  const visibleFlows = flows
    .filter(flow => matchesScopeFilter(flow.sourcePath))
    .filter(flow => viewFilter.length === 0 || (viewFilter.includes('bookmarked') && isBookmarked(flow)))
    .filter(flow =>
      !q ||
      flow.name.toLowerCase().includes(q) ||
      (flow.description ?? '').toLowerCase().includes(q)
    )
    .sort((a, b) => sortOrder === 'desc'
      ? b.name.localeCompare(a.name)
      : a.name.localeCompare(b.name)
    );

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
      {visibleFlows.length === 0 ? (
        <EmptyState title="No workflows found" text={q ? `No workflows match "${search}"` : 'Create a new multi-step flow to automate your tasks.'} icon={<Icon.GitBranch size={24} />} />
      ) : (
        <div className="stack">
          {visibleFlows.map(flow => (
            <FlowBoard
              key={flow.id}
              flow={flow}
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
              bookmarked={isBookmarked(flow)}
              onToggleBookmark={() => onToggleBookmark(flow)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default FlowsTab;
