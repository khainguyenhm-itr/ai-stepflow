import React from 'react';
import { Flow, FlowRunState, Agent, Skill } from '@ai-stepflow/core/types';
import { Icon } from '../components/primitives';
import { EmptyState } from '../components/ResourceCard';
import { ScopeFilterSelect, ScopeFilter, SaveScope } from '../components/ScopeControls';
import { FlowBoard } from './FlowBoard';
import { useScopeFilter } from '../hooks/useScopeFilter';

interface FlowsTabProps {
  flows: Flow[];
  agents: Agent[];
  skills: Skill[];
  auditLogs: Record<string, any[]>;
  activeFlow: Flow | null;
  runState: FlowRunState | null;
  runnerVisible: boolean;
  activeStepId: string | null;
  completedSteps: number;
  activeProgress: number;
  commandCopied: boolean;
  globalPath: string;
  projectPath: string;
  onRun: (flow: Flow) => void;
  onEdit: (flow: Flow) => void;
  onDetail: (flow: Flow) => void;
  onNew: (flow: Flow, scope: SaveScope) => void;
  onBoardStepEditor: (flow: Flow, index: number) => void;
  onBoardStepAdder: (flow: Flow) => void;
  onRemoveStep: (flow: Flow, index: number) => void;
  onSetActiveStep: (id: string) => void;
  onRunStep: (stepId: string, description: string) => void;
  onOpenFile: (path: string) => void;
  onCopyCommand: () => void;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
  initialFilter: ScopeFilter;
  onScopeFilterChange: (v: ScopeFilter) => void;
}

export const FlowsTab: React.FC<FlowsTabProps> = ({
  flows,
  agents,
  skills,
  auditLogs,
  activeFlow,
  runState,
  runnerVisible,
  activeStepId,
  completedSteps,
  activeProgress,
  commandCopied,
  globalPath,
  projectPath,
  onRun,
  onEdit,
  onDetail,
  onNew,
  onBoardStepEditor,
  onBoardStepAdder,
  onRemoveStep,
  onSetActiveStep,
  onRunStep,
  onOpenFile,
  onCopyCommand,
  outputEndRef,
  initialFilter,
  onScopeFilterChange
}) => {
  const [filter, setFilter] = useScopeFilter(initialFilter, onScopeFilterChange);

  const getItemScope = (sourcePath: string): SaveScope => {
    if (globalPath && sourcePath.startsWith(globalPath)) return 'global';
    return 'project';
  };

  const matchesScopeFilter = (sourcePath: string) => 
    filter === 'all' || getItemScope(sourcePath) === filter;

  const visibleFlows = flows.filter(flow => matchesScopeFilter(flow.sourcePath));

  return (
    <div className="page">
      <div className="page-head">
        <h2>Workflows</h2>
        <div className="page-head-actions">
          <ScopeFilterSelect value={filter} onChange={setFilter} />
          <button
            className="btn primary"
            onClick={() => {
              onNew(
                { id: `flow-${Date.now()}`, name: '', description: '', inputs: {}, steps: [], sourcePath: '' },
                filter === 'global' ? 'global' : 'project'
              );
            }}
          >
            <span className="btn-glyph plus"><Icon.Plus size={14} /></span>New Flow
          </button>
        </div>
      </div>
      {visibleFlows.length === 0 ? (
        <EmptyState title="No workflows found" text="Create a new multi-step flow to automate your tasks." icon={<Icon.GitBranch size={24} />} />
      ) : (
        <div className="stack">
          {visibleFlows.map(flow => (
            <FlowBoard
              key={flow.id}
              flow={flow}
              activeFlow={activeFlow}
              runState={runState}
              auditLogs={auditLogs}
              runnerVisible={runnerVisible}
              activeStepId={activeStepId}
              completedSteps={completedSteps}
              activeProgress={activeProgress}
              commandCopied={commandCopied}
              globalPath={globalPath}
              projectPath={projectPath}
              onRun={onRun}
              onEdit={onEdit}
              onDetail={onDetail}
              onBoardStepEditor={onBoardStepEditor}
              onBoardStepAdder={onBoardStepAdder}
              onRemoveStep={onRemoveStep}
              onSetActiveStep={onSetActiveStep}
              onRunStep={onRunStep}
              onOpenFile={onOpenFile}
              onCopyCommand={onCopyCommand}
              outputEndRef={outputEndRef}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default FlowsTab;
