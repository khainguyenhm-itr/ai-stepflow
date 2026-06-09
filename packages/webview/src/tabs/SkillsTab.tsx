import React, { useState } from 'react';
import { Skill } from '@ai-stepflow/core/types';
import { Icon } from '../components/primitives';
import { ResourceCard, EmptyState } from '../components/ResourceCard';
import { ScopeFilterSelect, ScopeFilter, SaveScope } from '../components/ScopeControls';
import { sendToVSCode } from '../vscode';

interface SkillsTabProps {
  skills: Skill[];
  globalPath: string;
  projectPath: string;
  onOpenEditor: (skill: Skill) => void;
  onRun: (skill: Skill) => void;
  onDetail: (skill: Skill) => void;
  onNew: (scope: SaveScope) => void;
}

export const SkillsTab: React.FC<SkillsTabProps> = ({
  skills,
  globalPath,
  projectPath,
  onOpenEditor,
  onRun,
  onDetail,
  onNew
}) => {
  const [filter, setFilter] = useState<ScopeFilter>('all');

  const getItemScope = (sourcePath: string): SaveScope => {
    if (globalPath && sourcePath.startsWith(globalPath)) return 'global';
    return 'project';
  };

  const matchesScopeFilter = (sourcePath: string) => 
    filter === 'all' || getItemScope(sourcePath) === filter;

  const visibleSkills = skills
    .filter(skill => matchesScopeFilter(skill.sourcePath))
    // Built-in (default) skills float to the top, then alphabetical.
    .sort((a, b) => (Number(!!b.builtIn) - Number(!!a.builtIn)) || a.name.localeCompare(b.name));

  const renderScopeBadge = (sourcePath: string) => {
    const scope = getItemScope(sourcePath);
    return <span className="badge scope">{scope === 'global' ? 'global' : 'repo'}</span>;
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>Skills</h2>
        <div className="page-head-actions">
          <ScopeFilterSelect value={filter} onChange={setFilter} />
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
      </div>
      {visibleSkills.length === 0 ? (
        <EmptyState title="No skills found" text="Create reusable skills that agents can use across different steps." icon={<Icon.Zap size={24} />} />
      ) : (
        <div className="card-grid">
          {visibleSkills.map(skill => (
            <ResourceCard
              key={skill.name}
              title={skill.name}
              description={skill.description}
              scopeBadge={renderScopeBadge(skill.sourcePath)}
              badge={skill.builtIn ? <span className="badge built-in">Build-in</span> : undefined}
              onEdit={() => onOpenEditor(skill)}
              actions={
                <button className="btn primary" onClick={() => onRun(skill)}>
                  <span className="btn-glyph"><Icon.Play size={14} /></span>Run
                </button>
              }
              onDetail={() => onDetail(skill)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
