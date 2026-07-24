import React, { useState } from 'react';
import { Agent } from '@claudesteps/core/types';
import { Icon } from '../components/primitives';
import { EmptyState } from '../components/ResourceCard';
import { ScopeFilter, SaveScope, ViewFilter, SortOrder, UnifiedFilterPanel } from '../components/ScopeControls';
import { sendToVSCode } from '../vscode';
import { useScopeFilter } from '../hooks/useScopeFilter';
import { useViewFilter } from '../hooks/useViewFilter';
import { useSortOrder } from '../hooks/useSortOrder';
import { GroupBy, groupByTag } from '../tagUtils';
import { GroupByToggle } from '../components/GroupByToggle';

interface AgentsTabProps {
  agents: Agent[];
  globalPath: string;
  projectPath: string;
  onOpenEditor: (agent: Agent) => void;
  onRun: (agent: Agent) => void;
  onHistory: (agent: Agent) => void;
  onDetail: (agent: Agent) => void;
  onNew: (scope: SaveScope) => void;
  initialFilter: ScopeFilter;
  onScopeFilterChange: (v: ScopeFilter) => void;
  initialViewFilter: ViewFilter;
  onViewFilterChange: (v: ViewFilter) => void;
  initialSortOrder: SortOrder;
  onSortOrderChange: (v: SortOrder) => void;
  initialGroupBy: GroupBy;
  onGroupByChange: (v: GroupBy) => void;
}

export const AgentsTab: React.FC<AgentsTabProps> = ({
  agents,
  globalPath,
  onOpenEditor,
  onRun,
  onHistory,
  onDetail,
  onNew,
  initialFilter,
  onScopeFilterChange,
  initialViewFilter,
  onViewFilterChange,
  initialSortOrder,
  onSortOrderChange,
  initialGroupBy,
  onGroupByChange,
}) => {
  const [filter, setFilter] = useScopeFilter(initialFilter, onScopeFilterChange);
  const [viewFilter, setViewFilter] = useViewFilter(initialViewFilter, onViewFilterChange);
  const [sortOrder, setSortOrder] = useSortOrder(initialSortOrder, onSortOrderChange);
  const [search, setSearch] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>(initialGroupBy);
  React.useEffect(() => { setGroupBy(initialGroupBy); }, [initialGroupBy]);
  const changeGroupBy = (v: GroupBy) => { setGroupBy(v); onGroupByChange(v); };

  const getItemScope = (sourcePath: string): SaveScope => {
    if (globalPath && sourcePath.startsWith(globalPath)) return 'global';
    return 'project';
  };

  const q = search.trim().toLowerCase();
  const visibleAgents = agents
    .filter(agent => filter === 'all' || getItemScope(agent.sourcePath) === filter)
    .filter(agent =>
      viewFilter.length === 0 ||
      (viewFilter.includes('built-in') && !!agent.builtIn)
    )
    .filter(agent =>
      !q ||
      agent.name.toLowerCase().includes(q) ||
      (agent.description ?? '').toLowerCase().includes(q)
    )
    .sort((a, b) => {
      if (sortOrder === 'activity' || sortOrder === 'newest') return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0);
      if (sortOrder === 'oldest') return (a.modifiedAt ?? 0) - (b.modifiedAt ?? 0);
      return (Number(!!b.builtIn) - Number(!!a.builtIn)) ||
        (sortOrder === 'desc' ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name));
    });

  const renderScopeBadge = (sourcePath: string) => {
    const scope = getItemScope(sourcePath);
    return <span className="badge scope">{scope === 'global' ? 'global' : 'repo'}</span>;
  };

  const renderRow = (agent: Agent) => {
    const fileTitle = agent.sourcePath.split('/').pop()?.replace(/\.md$/i, '') ?? agent.name;
    return (
      <tr className="drow" key={agent.sourcePath || agent.name}>
        <td>
          <div className="dname">
            <span className="dn">
              {fileTitle}
              {agent.builtIn && <span className="badge built-in">Build-in</span>}
            </span>
            <span className="dsub">{agent.description || 'No description.'}</span>
          </div>
        </td>
        <td className="dmodel">{agent.model}</td>
        <td>
          {agent.tools?.length ? (
            <div className="dtools">
              {agent.tools.slice(0, 3).map(t => <span className="dtool" key={t}>{t}</span>)}
              {agent.tools.length > 3 && <span className="dtool" title={agent.tools.slice(3).join(', ')}>...</span>}
            </div>
          ) : <span className="muted">—</span>}
        </td>
        <td>{renderScopeBadge(agent.sourcePath)}</td>
        <td className="drow-actions-cell">
          <span className="drow-actions">

            <button className="icon-btn" title="Run" onClick={() => onRun(agent)}><Icon.Play size={14} /></button>
            <button className="icon-btn" title="Run history" onClick={() => onHistory(agent)}><Icon.History size={14} /></button>
            <button className="icon-btn pencil" title="Edit" onClick={() => onOpenEditor(agent)}><Icon.Pencil size={14} /></button>
            <button className="icon-btn" title="Details" onClick={() => onDetail(agent)}><Icon.Info size={14} /></button>
          </span>
        </td>
      </tr>
    );
  };

  const table = (rows: Agent[]) => (
    <div className="dwrap scroll-x">
      <table className="dtable">
        <thead><tr><th style={{ width: '40%' }}>Name</th><th style={{ width: '12%' }}>Model</th><th style={{ width: '25%' }}>Tools</th><th style={{ width: '10%' }}>Scope</th><th style={{ width: '13%' }} /></tr></thead>
        <tbody>{rows.map(renderRow)}</tbody>
      </table>
    </div>
  );

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
          <GroupByToggle value={groupBy} onChange={changeGroupBy} />
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
      ) : groupBy === 'tag' ? (
        groupByTag(visibleAgents).map(group => (
          <section key={group.tag} className="tag-group">
            <h3 className="tag-group-title">{group.tag}<span className="sec-count">{group.items.length}</span></h3>
            {table(group.items)}
          </section>
        ))
      ) : (
        table(visibleAgents)
      )}
    </div>
  );
};
