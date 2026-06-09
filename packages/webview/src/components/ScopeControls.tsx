import React from 'react';

export type SaveScope = 'project' | 'global';
export type ScopeFilter = SaveScope | 'all';

interface ScopeFilterSelectProps {
  value: ScopeFilter;
  onChange: (value: ScopeFilter) => void;
}

export const ScopeFilterSelect: React.FC<ScopeFilterSelectProps> = ({ value, onChange }) => (
  <select className="select" value={value} onChange={e => onChange(e.target.value as ScopeFilter)}>
    <option value="all">All</option>
    <option value="project">Current repo</option>
    <option value="global">Global</option>
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
