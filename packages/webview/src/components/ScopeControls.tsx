import React, { useState, useRef, useEffect } from 'react';
import { Icon } from './primitives';

export type SaveScope = 'project' | 'global';
export type ScopeFilter = SaveScope | 'all';
export type ViewFilterItem = 'bookmarked' | 'built-in';
export type ViewFilter = ReadonlyArray<ViewFilterItem>; // [] = "all items"
export type SortOrder = 'asc' | 'desc';

// ── Legacy dropdown components (kept for any remaining uses) ─────────────────

export const ScopeFilterSelect: React.FC<{ value: ScopeFilter; onChange: (v: ScopeFilter) => void }> = ({ value, onChange }) => (
  <select className="select" value={value} onChange={e => onChange(e.target.value as ScopeFilter)}>
    <option value="all">All Scopes</option>
    <option value="project">Current Repo</option>
    <option value="global">Global</option>
  </select>
);

export const ViewFilterSelect: React.FC<{ value: ViewFilter; onChange: (v: ViewFilter) => void; showBuiltIn?: boolean }> = ({ value, onChange, showBuiltIn = true }) => {
  const strVal = value.length === 0 ? 'all' : value.length === 1 ? value[0] : 'all';
  return (
    <select className="select" value={strVal} onChange={e => {
      const v = e.target.value;
      onChange(v === 'all' ? [] : [v as ViewFilterItem]);
    }}>
      <option value="all">All Items</option>
      <option value="bookmarked">Bookmarked</option>
      {showBuiltIn && <option value="built-in">Built-in</option>}
    </select>
  );
};

export const SortOrderSelect: React.FC<{ value: SortOrder; onChange: (v: SortOrder) => void }> = ({ value, onChange }) => (
  <select className="select" value={value} onChange={e => onChange(e.target.value as SortOrder)}>
    <option value="asc">Sort A → Z</option>
    <option value="desc">Sort Z → A</option>
  </select>
);

export const SaveScopeSelect: React.FC<{ value: SaveScope; onChange: (v: SaveScope) => void }> = ({ value, onChange }) => (
  <select className="select" value={value} onChange={e => onChange(e.target.value as SaveScope)}>
    <option value="project">Current repo</option>
    <option value="global">Global</option>
  </select>
);

export const ScopeBadge: React.FC<{ scope: SaveScope }> = ({ scope }) => (
  <span className="badge scope">{scope === 'global' ? 'global' : 'repo'}</span>
);

// ── Unified filter panel ──────────────────────────────────────────────────────

interface UnifiedFilterPanelProps {
  scope: ScopeFilter;
  view: ViewFilter;
  sort: SortOrder;
  onApply: (scope: ScopeFilter, view: ViewFilter, sort: SortOrder) => void;
  showBuiltIn?: boolean;
}

function activeCount(scope: ScopeFilter, view: ViewFilter, sort: SortOrder): number {
  return (scope !== 'all' ? 1 : 0) + (view.length > 0 ? 1 : 0) + (sort !== 'asc' ? 1 : 0);
}

const Radio: React.FC<{ on: boolean }> = ({ on }) => (
  <span className={`fp-radio${on ? ' on' : ''}`} />
);

const Checkbox: React.FC<{ on: boolean }> = ({ on }) => (
  <span className={`fp-check${on ? ' on' : ''}`} />
);

export const UnifiedFilterPanel: React.FC<UnifiedFilterPanelProps> = ({
  scope, view, sort, onApply, showBuiltIn = true,
}) => {
  const [open, setOpen] = useState(false);
  const [pScope, setPScope] = useState<ScopeFilter>(scope);
  const [pView, setPView] = useState<ViewFilterItem[]>([...view]);
  const [pSort, setPSort] = useState<SortOrder>(sort);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setPScope(scope); }, [scope]);
  useEffect(() => { setPView([...view]); }, [view]);
  useEffect(() => { setPSort(sort); }, [sort]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggleView = (item: ViewFilterItem) =>
    setPView(prev => prev.includes(item) ? prev.filter(v => v !== item) : [...prev, item]);

  const handleApply = () => { onApply(pScope, pView, pSort); setOpen(false); };

  const handleReset = () => {
    setPScope('all'); setPView([]); setPSort('asc');
    onApply('all', [], 'asc');
    setOpen(false);
  };

  const n = activeCount(scope, view, sort);

  return (
    <div className="fp-wrap" ref={wrapRef}>
      <button className={`btn fp-btn${open ? ' active' : ''}`} type="button" onClick={() => setOpen(v => !v)}>
        <Icon.Settings size={13} />
        Filters
        {n > 0 && <span className="fp-badge">{n}</span>}
        <Icon.ChevronDown size={11} />
      </button>

      {open && (
        <div className="fp-panel">
          {/* ── Scope ── */}
          <div className="fp-section">
            <div className="fp-section-title">Scope</div>
            <div className="fp-options">
              {([['all', 'All'], ['project', 'Current repo'], ['global', 'Global']] as [ScopeFilter, string][]).map(([v, label]) => (
                <button key={v} type="button" className="fp-option" onClick={() => setPScope(v)}>
                  <Radio on={pScope === v} />{label}
                </button>
              ))}
            </div>
          </div>

          {/* ── View (multi-select checkboxes) ── */}
          <div className="fp-section">
            <div className="fp-section-title">View</div>
            <div className="fp-options">
              <button type="button" className="fp-option" onClick={() => setPView([])}>
                <Checkbox on={pView.length === 0} />All items
              </button>
              <button type="button" className="fp-option" onClick={() => toggleView('bookmarked')}>
                <Checkbox on={pView.includes('bookmarked')} />Bookmarked
              </button>
              {showBuiltIn && (
                <button type="button" className="fp-option" onClick={() => toggleView('built-in')}>
                  <Checkbox on={pView.includes('built-in')} />Built-in
                </button>
              )}
            </div>
          </div>

          {/* ── Sort ── */}
          <div className="fp-section">
            <div className="fp-section-title">Sort</div>
            <div className="fp-options">
              {([['asc', 'A → Z'], ['desc', 'Z → A']] as [SortOrder, string][]).map(([v, label]) => (
                <button key={v} type="button" className="fp-option" onClick={() => setPSort(v)}>
                  <Radio on={pSort === v} />{label}
                </button>
              ))}
            </div>
          </div>

          <div className="fp-footer">
            <button className="btn" type="button" onClick={handleReset}>Reset</button>
            <button className="btn primary" type="button" onClick={handleApply}>Apply Filter</button>
          </div>
        </div>
      )}
    </div>
  );
};
