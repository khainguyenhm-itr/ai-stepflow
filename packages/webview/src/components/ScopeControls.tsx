import React from 'react';

export type SaveScope = 'project' | 'global';
export type ScopeFilter = SaveScope | 'all';
export type ViewFilter = 'all' | 'bookmarked' | 'built-in';
export type SortOrder = 'asc' | 'desc';

interface ScopeFilterSelectProps {
  value: ScopeFilter;
  onChange: (value: ScopeFilter) => void;
}

export const ScopeFilterSelect: React.FC<ScopeFilterSelectProps> = ({ value, onChange }) => (
  <select className="select" value={value} onChange={e => onChange(e.target.value as ScopeFilter)}>
    <option value="all">All Scopes</option>
    <option value="project">Current Repo</option>
    <option value="global">Global</option>
  </select>
);

export const ViewFilterSelect: React.FC<{ value: ViewFilter, onChange: (v: ViewFilter) => void, showBuiltIn?: boolean }> = ({ value, onChange, showBuiltIn = true }) => (
  <select className="select" value={value} onChange={e => onChange(e.target.value as ViewFilter)}>
    <option value="all">All Items</option>
    <option value="bookmarked">Bookmarked</option>
    {showBuiltIn && <option value="built-in">Built-in</option>}
  </select>
);

export const SortOrderSelect: React.FC<{ value: SortOrder, onChange: (v: SortOrder) => void }> = ({ value, onChange }) => (
  <select className="select" value={value} onChange={e => onChange(e.target.value as SortOrder)}>
    <option value="asc">Sort A → Z</option>
    <option value="desc">Sort Z → A</option>
  </select>
);

interface SaveScopeSelectProps {
  value: SaveScope;
  onChange: (value: SaveScope) => void;
}

export const SaveScopeSelect: React.FC<SaveScopeSelectProps> = ({ value, onChange }) => (
  <select className="select" value={value} onChange={e => onChange(e.target.value as SaveScope)}>
    <option value="project">Current repo</option>
    <option value="global">Global</option>
  </select>
);

export const ScopeBadge: React.FC<{ scope: SaveScope }> = ({ scope }) => (
  <span className="badge scope">{scope === 'global' ? 'global' : 'repo'}</span>
);
