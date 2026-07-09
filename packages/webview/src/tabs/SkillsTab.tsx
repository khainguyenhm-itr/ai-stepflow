import React, { useState } from 'react';
import { Skill } from '@ai-stepflow/core/types';
import { Icon } from '../components/primitives';
import { EmptyState } from '../components/ResourceCard';
import { ScopeFilter, SaveScope, ViewFilter, SortOrder, UnifiedFilterPanel } from '../components/ScopeControls';
import { sendToVSCode } from '../vscode';
import { useScopeFilter } from '../hooks/useScopeFilter';
import { useViewFilter } from '../hooks/useViewFilter';
import { useSortOrder } from '../hooks/useSortOrder';
import { GroupBy, groupByTag } from '../tagUtils';
import { GroupByToggle } from '../components/GroupByToggle';

interface SkillsTabProps {
  skills: Skill[];
  globalPath: string;
  projectPath: string;
  onOpenEditor: (skill: Skill) => void;
  onRun: (skill: Skill) => void;
  onDetail: (skill: Skill) => void;
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

export const SkillsTab: React.FC<SkillsTabProps> = ({
  skills,
  globalPath,
  onOpenEditor,
  onRun,
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
  const visibleSkills = skills
    .filter(skill => filter === 'all' || getItemScope(skill.sourcePath) === filter)
    .filter(skill =>
      viewFilter.length === 0 ||
      (viewFilter.includes('built-in') && !!skill.builtIn)
    )
    .filter(skill =>
      !q ||
      skill.name.toLowerCase().includes(q) ||
      (skill.description ?? '').toLowerCase().includes(q)
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

  const renderRow = (skill: Skill) => {
    const parts = skill.sourcePath.split('/');
    const basename = parts[parts.length - 1] ?? '';
    const fileTitle = basename.toUpperCase() === 'SKILL.MD'
      ? (parts[parts.length - 2] ?? skill.name)
      : basename.replace(/\.md$/i, '') || skill.name;
    return (
      <tr className="drow" key={skill.sourcePath || skill.name}>
        <td>
          <div className="dname">
            <span className="dn">
              {fileTitle}
              {skill.builtIn && <span className="badge built-in">Build-in</span>}
            </span>
            <span className="dsub">{skill.description || 'No description.'}</span>
          </div>
        </td>
        <td>
          {skill.tags?.length ? (
            <div className="dtools">
              {skill.tags.slice(0, 3).map(t => <span className="dtool" key={t}>{t}</span>)}
              {skill.tags.length > 3 && <span className="dtool" title={skill.tags.slice(3).join(', ')}>...</span>}
            </div>
          ) : <span className="muted">—</span>}
        </td>
        <td>{renderScopeBadge(skill.sourcePath)}</td>
        <td className="drow-actions-cell">
          <span className="drow-actions">

            <button className="icon-btn" title="Run" onClick={() => onRun(skill)}><Icon.Play size={14} /></button>
            <button className="icon-btn pencil" title="Edit" onClick={() => onOpenEditor(skill)}><Icon.Pencil size={14} /></button>
            <button className="icon-btn" title="Details" onClick={() => onDetail(skill)}><Icon.Info size={14} /></button>
          </span>
        </td>
      </tr>
    );
  };

  const table = (rows: Skill[]) => (
    <div className="dwrap scroll-x">
      <table className="dtable">
        <thead><tr><th style={{ width: '46%' }}>Name</th><th style={{ width: '28%' }}>Tags</th><th style={{ width: '12%' }}>Scope</th><th style={{ width: '14%' }} /></tr></thead>
        <tbody>{rows.map(renderRow)}</tbody>
      </table>
    </div>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-search">
          <span className="page-search-icon"><Icon.Search size={14} /></span>
          <input
            className="page-search-input"
            type="text"
            placeholder="Search skills…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <span className="ph-spacer" />
        <GroupByToggle value={groupBy} onChange={changeGroupBy} />
        <UnifiedFilterPanel
          scope={filter}
          view={viewFilter}
          sort={sortOrder}
          onApply={(s, v, o) => { setFilter(s); setViewFilter(v); setSortOrder(o); }}
        />
        <button className="btn" title="Create a skill from an existing markdown file" onClick={() => sendToVSCode('importSkillFile', {})}>
          <span className="btn-glyph"><Icon.Upload size={14} /></span>Import file
        </button>
        <button
          className="btn primary"
          onClick={() => onNew(filter === 'global' ? 'global' : 'project')}
        >
          <span className="btn-glyph plus"><Icon.Plus size={14} /></span>New Skill
        </button>
      </div>
      {visibleSkills.length === 0 ? (
        <EmptyState title="No skills found" text={q ? `No skills match "${search}"` : 'Create reusable skills that agents can use across different steps.'} icon={<Icon.Zap size={24} />} />
      ) : groupBy === 'tag' ? (
        groupByTag(visibleSkills).map(group => (
          <section key={group.tag} className="tag-group">
            <h3 className="tag-group-title">{group.tag}<span className="sec-count">{group.items.length}</span></h3>
            {table(group.items)}
          </section>
        ))
      ) : (
        table(visibleSkills)
      )}
    </div>
  );
};
