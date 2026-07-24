import React, { useState } from 'react';
import { ReviewKit } from '@claudesteps/core/types';
import { Icon } from '../components/primitives';
import { EmptyState } from '../components/ResourceCard';
import { ScopeFilter, SaveScope, ViewFilter, SortOrder, UnifiedFilterPanel } from '../components/ScopeControls';
import { sendToVSCode } from '../vscode';
import { useScopeFilter } from '../hooks/useScopeFilter';
import { useViewFilter } from '../hooks/useViewFilter';
import { useSortOrder } from '../hooks/useSortOrder';

interface ReviewsTabProps {
  reviewKits: ReviewKit[];
  globalPath: string;
  onOpenEditor: (kit: ReviewKit) => void;
  onDetail: (kit: ReviewKit) => void;
  onNew: (scope: SaveScope) => void;
  onInstallDefault: () => void;
  initialFilter: ScopeFilter;
  onScopeFilterChange: (v: ScopeFilter) => void;
  initialViewFilter: ViewFilter;
  onViewFilterChange: (v: ViewFilter) => void;
  initialSortOrder: SortOrder;
  onSortOrderChange: (v: SortOrder) => void;
}

export const ReviewsTab: React.FC<ReviewsTabProps> = ({
  reviewKits,
  globalPath,
  onOpenEditor,
  onDetail,
  onNew,
  onInstallDefault,
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
  const visibleKits = reviewKits
    .filter(kit => filter === 'all' || getItemScope(kit.sourcePath) === filter)
    .filter(kit =>
      viewFilter.length === 0 ||
      (viewFilter.includes('built-in') && !!kit.builtIn)
    )
    .filter(kit =>
      !q ||
      kit.name.toLowerCase().includes(q) ||
      (kit.description ?? '').toLowerCase().includes(q)
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

  const renderRow = (kit: ReviewKit) => (
    <tr className="drow" key={kit.sourcePath || kit.name}>
      <td>
        <div className="dname">
          <span className="dn">
            {kit.name}
            {kit.builtIn && <span className="badge built-in">Build-in</span>}
          </span>
          <span className="dsub">{kit.description || 'No description.'}</span>
        </div>
      </td>
      <td>{renderScopeBadge(kit.sourcePath)}</td>
      <td className="drow-actions-cell">
        <span className="drow-actions">
          <button className="icon-btn pencil" title="Edit" onClick={() => onOpenEditor(kit)}><Icon.Pencil size={14} /></button>
          <button className="icon-btn" title="Details" onClick={() => onDetail(kit)}><Icon.Info size={14} /></button>
          <button className="icon-btn" title="Delete" onClick={() => sendToVSCode('deleteReviewKit', { review: kit })}><Icon.Trash2 size={14} /></button>
        </span>
      </td>
    </tr>
  );

  return (
    <div className="page">
      <div className="page-head">
        <h2>Reviews</h2>
        <div className="page-head-actions">
          <div className="page-search">
            <span className="page-search-icon"><Icon.Search size={14} /></span>
            <input
              className="page-search-input"
              type="text"
              placeholder="Search reviews…"
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
          <button className="btn" title="Install the bundled default review kit" onClick={onInstallDefault}>
            <span className="btn-glyph"><Icon.Sparkles size={14} /></span>Install default
          </button>
          <button className="btn" title="Create a review kit from an existing markdown file" onClick={() => sendToVSCode('importReviewFile', {})}>
            <span className="btn-glyph"><Icon.Upload size={14} /></span>Import file
          </button>
          <button
            className="btn primary"
            onClick={() => onNew(filter === 'global' ? 'global' : 'project')}
          >
            <span className="btn-glyph plus"><Icon.Plus size={14} /></span>New Review
          </button>
        </div>
      </div>
      {visibleKits.length === 0 ? (
        <EmptyState title="No review kits found" text={q ? `No review kits match "${search}"` : 'Create review-kit prompts the deep-LLM-review layer uses to judge produced artifacts.'} icon={<Icon.Bookmark size={24} />} />
      ) : (
        <div className="dwrap scroll-x">
          <table className="dtable">
            <thead><tr><th style={{ width: '74%' }}>Name</th><th style={{ width: '12%' }}>Scope</th><th style={{ width: '14%' }} /></tr></thead>
            <tbody>{visibleKits.map(renderRow)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
};
