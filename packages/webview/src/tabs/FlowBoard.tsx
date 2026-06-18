import React, { useState, useEffect, useRef } from 'react';
import { Flow, FlowRunState } from '@ai-stepflow/core/types';
import { Icon } from '../components/primitives';
import { EmptyState } from '../components/ResourceCard';
import { getFlowColumns } from '../flowUtils';
import { sendToVSCode } from '../vscode';
import { InlineRunner } from './InlineRunner';

interface FlowBoardProps {
  flow: Flow;
  activeFlow: Flow | null;
  runState: FlowRunState | null;
  auditLogs: Record<string, any[]>;
  runSummaries: { flowId: string; runId: string; runName?: string; completedSteps: number; totalSteps: number; mtimeMs: number }[];
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
  runSummaries,
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
  const [isExpanded, setIsExpanded] = useState(false);
  const prevRunnerOpenRef = useRef(runnerOpen);

  // Auto-expand only when runnerOpen transitions false→true (new run started),
  // not on remount when a run was already active.
  useEffect(() => {
    const wasOpen = prevRunnerOpenRef.current;
    prevRunnerOpenRef.current = runnerOpen;
    if (runnerOpen && !wasOpen) setIsExpanded(true);
  }, [runnerOpen]);

  // Auto-load most recent run when expanding (if no active run and runs exist).
  const handleExpand = () => {
    setIsExpanded(prev => {
      const next = !prev;
      if (next && !runnerOpen && runSummaries.length > 0) {
        const mostRecent = [...runSummaries].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
        sendToVSCode('switchRun', { flowId: flow.id, runId: mostRecent.runId });
      }
      return next;
    });
  };

  return (
    <div className="panel">
      {/* Panel header — always visible */}
      <div className="panel-head">
        <div className="panel-head-info">
          <span className="panel-title">{flow.name}</span>
          <span className="muted small">{flow.steps.length} steps</span>
          {runnerOpen && <span className="badge progress">run active</span>}
        </div>
        <div className="panel-head-actions">
          <button
            className="icon-btn"
            title={isExpanded ? 'Collapse' : 'Expand'}
            onClick={handleExpand}
          >
            {isExpanded ? <Icon.ChevronUp size={18} /> : <Icon.ChevronDown size={18} />}
          </button>
          <button className="icon-btn pencil" title="Edit flow" onClick={() => onEdit(flow)}><Icon.Pencil size={14} /></button>
          <button className="icon-btn" title="Details" onClick={() => onDetail(flow)}>
            <Icon.Info size={14} />
          </button>
          {flow.sourcePath && (
            <button className="icon-btn danger" title="Delete flow" onClick={() => sendToVSCode('deleteFlow', { flow })}><Icon.X size={14} /></button>
          )}
        </div>
      </div>

      {/* Step flow canvas — always visible */}
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

      {/* Expanded: run controls + inline runner */}
      {isExpanded && (
        <>
          <div className="flow-run-controls">
            {runSummaries.length > 0 && (
              <div className="flex-row items-center gap-4">
                <span className="small muted" style={{ flexShrink: 0 }}>Resume:</span>
                <select
                  className="input sm"
                  style={{ minWidth: '180px', maxWidth: 'auto' }}
                  value={runnerOpen ? (runState?.runId || '') : ''}
                  onChange={e => {
                    if (e.target.value) {
                      sendToVSCode('switchRun', { flowId: flow.id, runId: e.target.value });
                    }
                  }}
                >
                  <option value="" disabled>Select run...</option>
                  {runSummaries.map(s => (
                    <option key={s.runId} value={s.runId}>
                      {s.runName || s.runId.split('T')[0]} ({s.completedSteps}/{s.totalSteps})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <button
              className="btn primary"
              style={{ marginLeft: 'auto' }}
              title="Start a new independent run"
              onClick={() => onRun(flow)}
            >
              <span className="btn-glyph"><Icon.Plus size={14} /></span>New Run
            </button>
          </div>

          {runnerOpen && runState ? (
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
          ) : runSummaries.length === 0 ? (
            <EmptyState
              title="No runs yet"
              text="Click New Run to start the first run of this workflow."
              icon={<Icon.Play size={24} />}
            />
          ) : null}
        </>
      )}
    </div>
  );
};
