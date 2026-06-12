import React, { useState } from 'react';
import { Agent, Skill } from '@ai-stepflow/core/types';
import { Icon } from '../components/primitives';
import { ResourceCard, EmptyState } from '../components/ResourceCard';
import { ScopeFilterSelect, ScopeFilter, SaveScope } from '../components/ScopeControls';
import { sendToVSCode } from '../vscode';

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
}

export const AgentsTab: React.FC<AgentsTabProps> = ({
  agents,
  globalPath,
  projectPath,
  onOpenEditor,
  onRun,
  onDetail,
  onNew,
  isBookmarked,
  onToggleBookmark
}) => {
  const [filter, setFilter] = useState<ScopeFilter>('all');

  const getItemScope = (sourcePath: string): SaveScope => {
    if (globalPath && sourcePath.startsWith(globalPath)) return 'global';
    return 'project';
  };

  const matchesScopeFilter = (sourcePath: string) => 
    filter === 'all' || getItemScope(sourcePath) === filter;

  const visibleAgents = agents
    .filter(agent => matchesScopeFilter(agent.sourcePath))
    // Bookmarked agents are easiest to reach, then built-ins, then alphabetical.
    .sort((a, b) =>
      (Number(isBookmarked(b)) - Number(isBookmarked(a)))
      || (Number(!!b.builtIn) - Number(!!a.builtIn))
      || a.name.localeCompare(b.name)
    );

  const renderScopeBadge = (sourcePath: string) => {
    const scope = getItemScope(sourcePath);
    return <span className="badge scope">{scope === 'global' ? 'global' : 'repo'}</span>;
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>Agents</h2>
        <div className="page-head-actions">
          <ScopeFilterSelect value={filter} onChange={setFilter} />
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
        <EmptyState title="No agents found" text="Define a specialized AI agent with a custom system prompt and tools." icon={<Icon.User size={24} />} />
      ) : (
        <div className="card-grid">
          {visibleAgents.map(agent => (
            <ResourceCard
              key={agent.name}
              title={agent.name}
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
