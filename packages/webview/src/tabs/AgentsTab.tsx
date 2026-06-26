import React, { useState } from 'react';
import { Agent } from '@ai-stepflow/core/types';
import { Icon } from '../components/primitives';
import { ResourceCard, EmptyState } from '../components/ResourceCard';
import { ScopeFilter, SaveScope, ViewFilter, SortOrder, UnifiedFilterPanel } from '../components/ScopeControls';
import { sendToVSCode } from '../vscode';
import { useScopeFilter } from '../hooks/useScopeFilter';
import { useViewFilter } from '../hooks/useViewFilter';
import { useSortOrder } from '../hooks/useSortOrder';

interface AgentsTabProps {
  agents: Agent[];
  globalPath: string;
  projectPath: string;
  onOpenEditor: (agent: Agent) => void;
  onRun: (agent: Agent) => void;
  onDetail: (agent: Agent) => void;
  onNew: (scope: SaveScope) => void;
  isBookmarked: (agent: Agent) => boolean;
  onToggleBookmark: (agent: Agent) => void;
  initialFilter: ScopeFilter;
  onScopeFilterChange: (v: ScopeFilter) => void;
  initialViewFilter: ViewFilter;
  onViewFilterChange: (v: ViewFilter) => void;
  initialSortOrder: SortOrder;
  onSortOrderChange: (v: SortOrder) => void;
}

export const AgentsTab: React.FC<AgentsTabProps> = ({
  agents,
  globalPath,
  onOpenEditor,
  onRun,
  onDetail,
  onNew,
  isBookmarked,
  onToggleBookmark,
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

  const q = search.trim().toLowerCase();
  const visibleAgents = agents
    .filter(agent => filter === 'all' || getItemScope(agent.sourcePath) === filter)
    .filter(agent =>
      viewFilter.length === 0 ||
      (viewFilter.includes('bookmarked') && isBookmarked(agent)) ||
      (viewFilter.includes('built-in') && !!agent.builtIn)
    )
    .filter(agent =>
      !q ||
      agent.name.toLowerCase().includes(q) ||
      (agent.description ?? '').toLowerCase().includes(q)
    )
    .sort((a, b) => {
      if (sortOrder === 'newest') return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0);
      if (sortOrder === 'oldest') return (a.modifiedAt ?? 0) - (b.modifiedAt ?? 0);
      return (Number(!!b.builtIn) - Number(!!a.builtIn)) ||
        (sortOrder === 'desc' ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name));
    });

  const renderScopeBadge = (sourcePath: string) => {
    const scope = getItemScope(sourcePath);
    return <span className="badge scope">{scope === 'global' ? 'global' : 'repo'}</span>;
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>Agents</h2>
        <div className="page-head-actions">
          <div className="page-search">
            <span className="page-search-icon"><Icon.Search size={14} /></span>
            <input
              className="page-search-input"
              type="text"
              placeholder="Search agents…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <UnifiedFilterPanel
            scope={filter}
            view={viewFilter}
            sort={sortOrder}
            onApply={(s, v, o) => { setFilter(s); setViewFilter(v); setSortOrder(o); }}
          />
          <button className="btn" title="Create an agent from an existing markdown file" onClick={() => sendToVSCode('importAgentFile', {})}>
            <span className="btn-glyph"><Icon.Upload size={14} /></span>Import file
          </button>
          <button
            className="btn primary"
            onClick={() => onNew(filter === 'global' ? 'global' : 'project')}
          >
            <span className="btn-glyph plus"><Icon.Plus size={14} /></span>New Agent
          </button>
        </div>
      </div>
      {visibleAgents.length === 0 ? (
        <EmptyState title="No agents found" text={q ? `No agents match "${search}"` : 'Define a specialized AI agent with a custom system prompt and tools.'} icon={<Icon.User size={24} />} />
      ) : (
        <div className="card-grid">
          {visibleAgents.map(agent => (
            <ResourceCard
              key={agent.name}
              title={agent.sourcePath.split('/').pop()?.replace(/\.md$/i, '') ?? agent.name}
              subtitle={agent.name}
              description={agent.description}
              scopeBadge={renderScopeBadge(agent.sourcePath)}
              badge={agent.builtIn ? <span className="badge built-in">Build-in</span> : undefined}
              meta={<span className="muted small mono">model: {agent.model}</span>}
              onEdit={() => onOpenEditor(agent)}
              bookmarked={isBookmarked(agent)}
              onToggleBookmark={() => onToggleBookmark(agent)}
              actions={
                <button className="btn primary" onClick={() => onRun(agent)}>
                  <span className="btn-glyph"><Icon.Play size={14} /></span>Run
                </button>
              }
              onDetail={() => onDetail(agent)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
