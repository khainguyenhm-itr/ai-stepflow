import React from 'react';
import { Icon } from './primitives';
import { GroupBy } from '../tagUtils';

/** Segmented toggle switching a resource list between the flat list ("as before") and a
 *  tag-grouped view. */
export const GroupByToggle: React.FC<{ value: GroupBy; onChange: (v: GroupBy) => void }> = ({ value, onChange }) => (
  <div className="segmented" role="group" aria-label="View mode">
    <button
      type="button"
      className={`segmented-btn ${value === 'list' ? 'active' : ''}`}
      title="Show as a flat list"
      aria-pressed={value === 'list'}
      onClick={() => onChange('list')}
    >
      <Icon.GripVertical size={13} />List
    </button>
    <button
      type="button"
      className={`segmented-btn ${value === 'tag' ? 'active' : ''}`}
      title="Group by tag"
      aria-pressed={value === 'tag'}
      onClick={() => onChange('tag')}
    >
      <Icon.GitBranch size={13} />Groups
    </button>
  </div>
);
