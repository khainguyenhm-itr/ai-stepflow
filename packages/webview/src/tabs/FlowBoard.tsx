import React from 'react';
import { Flow, FlowRunState } from '@ai-stepflow/core/types';
import { Icon } from '../components/primitives';
import { getFlowColumns } from '../flowUtils';
import { sendToVSCode } from '../vscode';
import { InlineRunner } from './InlineRunner';

interface FlowBoardProps {
  flow: Flow;
  activeFlow: Flow | null;
  runState: FlowRunState | null;
  auditLogs: Record<string, any[]>;
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
  onBoardStepEditor: (flow: Flow, index: number) => void;
  onBoardStepAdder: (flow: Flow) => void;
  onRemoveStep: (flow: Flow, index: number) => void;
  onSetActiveStep: (id: string) => void;
  onRunStep: (stepId: string, description: string) => void;
  onOpenFile: (path: string) => void;
  onCopyCommand: () => void;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
}

export const FlowBoard: React.FC<FlowBoardProps> = ({
  flow,
  activeFlow,
  runState,
  auditLogs,
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
  onBoardStepEditor,
  onBoardStepAdder,
  onRemoveStep,
  onSetActiveStep,
  onRunStep,
  onOpenFile,
  onCopyCommand,
  outputEndRef
}) => {
  const columns = getFlowColumns(flow);
  const runnerOpen = activeFlow?.id === flow.id && !!runState && runnerVisible;

  const getScope = (sourcePath: string) => {
    if (globalPath && sourcePath.startsWith(globalPath)) return 'Global';
    if (projectPath && sourcePath.startsWith(projectPath)) return 'Current repo';
    return sourcePath.includes('/preview/') ? 'Preview' : 'Current repo';
  };

  return (
    <div key={flow.id} className="panel">
      <div className="panel-head">
        <div className="panel-head-info">
          <span className="panel-title">{flow.name}</span>
          <span className="muted small">{flow.steps.length} steps</span>
        </div>
        <div className="panel-head-actions">
          <button
            className={`btn ${runnerOpen ? '' : 'primary'}`}
            title={runnerOpen ? 'Hide the run panel (the run is kept)' : 'Run this workflow'}
            onClick={() => onRun(flow)}
          >
            <span className="btn-glyph">{runnerOpen ? <Icon.ChevronUp size={14} /> : <Icon.Play size={14} />}</span>{runnerOpen ? 'Hide' : 'Run'}
          </button>
          <button className="icon-btn pencil" title="Edit flow" onClick={() => onEdit(flow)}><Icon.Pencil size={14} /></button>
          <button
            className="icon-btn"
            title="Details"
            onClick={() => onDetail(flow)}
          >
            <Icon.Info size={14} />
          </button>
          {flow.sourcePath && (
            <button className="icon-btn danger" title="Delete flow" onClick={() => sendToVSCode('deleteFlow', { flow })}><Icon.X size={14} /></button>
          )}
        </div>
      </div>
      <div className="flow-canvas">
        <div className="flow-track">
          {columns.map((column, columnIndex) => (
            <React.Fragment key={`${flow.id}-${columnIndex}`}>
              <div className="flow-stage">
                {column.map((step, rowIndex) => {
                  const stepNumber = column.length > 1 ? `${columnIndex + 1}.${rowIndex + 1}` : `${columnIndex + 1}`;
                  const needsReview = step.review.required;
                  const reviewLabel = step.review.type === 'ai' ? 'auto review' : 'human review';
                  const stepIndex = flow.steps.findIndex(s => s.id === step.id);
                  return (
                    <div
                      key={step.id}
                      className="flow-step-card editable"
                      role="button"
                      tabIndex={0}
                      title="Edit step"
                      onClick={() => onBoardStepEditor(flow, stepIndex)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBoardStepEditor(flow, stepIndex); } }}
                    >
                      <div className="flow-step-heading">
                        <span className="flow-step-number">{stepNumber}</span>
                        <span className="flow-step-title">{step.title || step.id}</span>
                        <span className="flow-step-actions">
                          <button
                            type="button"
                            className="icon-btn sm gear"
                            title="Edit step"
                            onClick={e => { e.stopPropagation(); onBoardStepEditor(flow, stepIndex); }}
                          >
                            <Icon.Settings size={12} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn sm danger"
                            title="Remove step"
                            onClick={e => { e.stopPropagation(); onRemoveStep(flow, stepIndex); }}
                          >
                            <Icon.X size={14} />
                          </button>
                        </span>
                      </div>
                      <div className="flow-step-sub mono">agent:{step.agent || 'unassigned'}</div>
                      {needsReview && (
                        <span className="flow-step-review" title={reviewLabel}>
                          {step.review.type === 'ai' ? <Icon.Bot size={12} /> : <Icon.User size={12} />}
                          <span>{reviewLabel}</span>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {columnIndex < columns.length - 1 && <div className="flow-connector" />}
            </React.Fragment>
          ))}
          <button type="button" className="flow-add-node" onClick={() => onBoardStepAdder(flow)} aria-label="Add workflow step"><Icon.Plus size={14} /></button>
        </div>
      </div>
      {runnerOpen && runState && (
        <InlineRunner
          flow={flow}
          runState={runState}
          auditLogs={auditLogs}
          activeStepId={activeStepId}
          completedSteps={completedSteps}
          activeProgress={activeProgress}
          commandCopied={commandCopied}
          onSetActiveStep={onSetActiveStep}
          onRunStep={onRunStep}
          onOpenFile={onOpenFile}
          onCopyCommand={onCopyCommand}
          outputEndRef={outputEndRef}
        />
      )}
    </div>
  );
};
