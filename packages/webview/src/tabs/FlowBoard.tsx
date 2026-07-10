import React, { useState, useEffect, useRef } from 'react';
import { Flow, FlowRunState } from '@ai-stepflow/core/types';
import { Icon, Modal } from '../components/primitives';
import { getFlowColumns } from '../flowUtils';
import { sendToVSCode } from '../vscode';
import { InlineRunner } from './InlineRunner';
import { FlowGraphCanvas } from '../components/FlowGraphCanvas';

type RunSummary = {
  flowId: string; runId: string; runName?: string;
  completedSteps: number; totalSteps: number; mtimeMs: number; isClosed: boolean;
};

interface FlowBoardProps {
  flow: Flow;
  activeFlow: Flow | null;
  runState: FlowRunState | null;
  auditLogs: Record<string, any[]>;
  runSummaries: RunSummary[];
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
  scopeBadge: React.ReactNode;
}

const fmtAgo = (ms: number): string => {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
};

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
  outputEndRef,
  scopeBadge,
}) => {
  const columns = getFlowColumns(flow);
  const runnerOpen = activeFlow?.id === flow.id && !!runState && runnerVisible;
  const [graphOpen, setGraphOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(runnerOpen);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(runState?.runId || null);
  const [confirmRemoveIndex, setConfirmRemoveIndex] = useState<number | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (runnerOpen) setRunsOpen(true); }, [runnerOpen, runState?.runId]);

  const activeRuns = runSummaries.filter(s => !s.isClosed);
  const total = flow.steps.length;
  const latest = [...runSummaries].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  const doneCount = latest ? Math.min(latest.completedSteps, total) : 0;

  let statusKey: 'run' | 'ok' | 'idle' = 'idle';
  let statusLabel = 'Idle';
  if (runnerOpen && runState) { statusKey = 'run'; statusLabel = 'Running'; }
  else if (activeRuns.length > 0) { statusKey = 'run'; statusLabel = 'In progress'; }
  else if (runSummaries.length > 0) { statusKey = 'ok'; statusLabel = 'Done'; }

  const toggleRuns = () => {
    setRunsOpen(prev => {
      const next = !prev;
      if (next && !runnerOpen && activeRuns.length > 0) {
        const mostRecent = [...activeRuns].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
        sendToVSCode('switchRun', { flowId: flow.id, runId: mostRecent.runId });
      }
      return next;
    });
  };

  const runStatusBadge = (s: RunSummary) => {
    if (s.isClosed) return <span className="badge ok">Finalized</span>;
    if (s.completedSteps >= s.totalSteps) return <span className="badge ok">Done</span>;
    return <span className="badge run">In progress</span>;
  };

  return (
    <tbody className="flow-tbody">
      {/* main row */}
      <tr className={`drow ${graphOpen ? 'graph-on' : ''}`}>
        <td>
          <span className="dstatus">
            <span className={`ddot ${statusKey}`} />
            <span className="dstatus-label">{statusLabel}</span>
          </span>
        </td>
        <td className="name-cell" onClick={() => setGraphOpen(o => !o)} title="Show flow graph">
          <div className="dname">
            <span className="dn"><span className="chev-inline"><Icon.ChevronRight size={14} /></span>{flow.name}</span>
            <span className="dsub">{flow.description || 'No description.'}</span>
          </div>
        </td>
        <td className="mono muted">{runSummaries.length} {runSummaries.length === 1 ? 'run' : 'runs'}</td>
        <td>{scopeBadge}</td>
        <td>
          <span className="pipe">
            {flow.steps.map((s, i) => (
              <span key={s.id} className={`seg ${i < doneCount ? 'done' : (i === doneCount && statusKey === 'run' ? 'active' : '')}`} />
            ))}
            <span className="pipe-num">{total}</span>
          </span>
        </td>
        <td className="drow-actions-cell">
          <span className="drow-actions">
            <button className="icon-btn" title="New run" onClick={() => onRun(flow)}><Icon.Play size={14} /></button>
            <button className={`icon-btn ${runsOpen ? 'active' : ''}`} title="Runs" onClick={toggleRuns}><Icon.List size={14} /></button>

            <button className="icon-btn pencil" title="Edit flow" onClick={() => onEdit(flow)}><Icon.Pencil size={14} /></button>
            <button className="icon-btn" title="Details" onClick={() => onDetail(flow)}><Icon.Info size={14} /></button>
            {flow.sourcePath && (
              <button className="icon-btn danger" title="Delete flow" onClick={() => sendToVSCode('deleteFlow', { flow })}><Icon.Trash2 size={14} /></button>
            )}
          </span>
        </td>
      </tr>

      {/* graph expand */}
      {graphOpen && (
        <tr className="detail-row graph-dr">
          <td colSpan={6}>
            <div className="detail">
              <div className="detail-subhead">
                <h4>Flow graph</h4>
                <span className="hint">preview — click ▶ to run</span>
              </div>
              <div className="flow-canvas" style={{ position: 'relative' }} ref={canvasRef}>
                <FlowGraphCanvas steps={flow.steps} containerRef={canvasRef} isExpanded={graphOpen} />
                <div className="flow-track" style={{ position: 'relative', zIndex: 1 }}>
                  {columns.map((column, columnIndex) => (
                    <div className="flow-stage" key={`${flow.id}-${columnIndex}`}>
                      {column.map((step, rowIndex) => {
                        const stepNumber = column.length > 1 ? `${columnIndex + 1}.${rowIndex + 1}` : `${columnIndex + 1}`;
                        const reviewLabel = step.review.type === 'ai' ? 'auto review' : 'human review';
                        const stepIndex = flow.steps.findIndex(s => s.id === step.id);
                        return (
                          <div key={step.id} id={`step-node-${step.id}`} className="flow-step-card editable">
                            <div className="flow-step-heading">
                              <span className="flow-step-number">{stepNumber}</span>
                              <span className="flow-step-title">{step.title || step.id}</span>
                              <span className="flow-step-actions">
                                <button type="button" className="icon-btn sm gear" title="Edit step" onClick={e => { e.stopPropagation(); onBoardStepEditor(flow, stepIndex); }}><Icon.Settings size={12} /></button>
                                <button type="button" className="icon-btn sm danger" title="Remove step" onClick={e => { e.stopPropagation(); setConfirmRemoveIndex(stepIndex); }}><Icon.X size={14} /></button>
                              </span>
                            </div>
                            <div className="flow-step-sub mono">agent:{step.agent || 'unassigned'}</div>
                            <span className="flow-step-review" title={reviewLabel}>
                              {step.review.type === 'ai' ? <Icon.Bot size={12} /> : <Icon.User size={12} />}
                              <span>{reviewLabel}</span>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  <button type="button" className="flow-add-node" onClick={() => onBoardStepAdder(flow)} aria-label="Add workflow step"><Icon.Plus size={14} /></button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}

      {/* runs expand */}
      {runsOpen && (
        <tr className="detail-row runs-dr">
          <td colSpan={6}>
            <div className="detail">
              <div className="detail-subhead">
                <h4>Runs</h4>
                <span className="badge idle">{runSummaries.length} total</span>
                <span className="hint">tạo run mới bằng ▶ trên dòng flow</span>
              </div>

              {runSummaries.length === 0 ? (
                <div className="run-empty">No runs yet — click ▶ to create the first run.</div>
              ) : (
                <div className="dwrap scroll-x">
                  <table className="dtable">
                    <thead>
                      <tr>
                        <th style={{ width: 32 }}></th>
                        <th>Run</th>
                        <th style={{ width: 100 }}>Status</th>
                        <th style={{ width: 80 }}>Progress</th>
                        <th style={{ width: 90 }}>Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...runSummaries].sort((a, b) => b.mtimeMs - a.mtimeMs).map(s => {
                        const isExpanded = expandedRunId === s.runId;
                        const isActive = runnerOpen && runState?.runId === s.runId;
                        const runData = isActive ? runState : null;
                        return (
                          <React.Fragment key={s.runId}>
                            <tr
                              className={`run-row-item ${isExpanded ? 'expanded' : ''} ${isActive ? 'sel' : ''}`}
                              onClick={() => {
                                if (!isActive) {
                                  sendToVSCode('switchRun', { flowId: flow.id, runId: s.runId });
                                }
                              }}
                            >
                              <td className="run-expand-cell">
                                <button
                                  className="icon-btn expand-btn"
                                  title={isExpanded ? 'Collapse' : 'Expand'}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedRunId(isExpanded ? null : s.runId);
                                  }}
                                >
                                  <Icon.ChevronRight size={14} />
                                </button>
                              </td>
                              <td>
                                <strong>{s.runName || s.runId.split('T')[0]}</strong>
                                <span className="mono muted small" style={{ marginLeft: 8 }}>{s.runId.slice(-6)}</span>
                              </td>
                              <td>{runStatusBadge(s)}</td>
                              <td className="mono">{s.completedSteps} / {s.totalSteps}</td>
                              <td className="muted small">{fmtAgo(s.mtimeMs)}</td>
                            </tr>

                            {/* Expandable detail row */}
                            {isExpanded && runData && (
                              <tr className="run-detail-row">
                                <td colSpan={6}>
                                  <div className="run-detail-expand">
                                    <InlineRunner
                                      flow={flow}
                                      runState={runData}
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
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}

      <Modal
        title="Remove step?"
        open={confirmRemoveIndex !== null}
        onClose={() => setConfirmRemoveIndex(null)}
        width={400}
        footer={
          <>
            <button className="btn danger" onClick={() => { const i = confirmRemoveIndex!; setConfirmRemoveIndex(null); onRemoveStep(flow, i); }}>
              <Icon.Trash2 size={14} />Remove
            </button>
            <button className="btn" onClick={() => setConfirmRemoveIndex(null)}>Cancel</button>
          </>
        }
      >
        {confirmRemoveIndex !== null && (
          <p>Remove step <strong>{flow.steps[confirmRemoveIndex]?.title || flow.steps[confirmRemoveIndex]?.id}</strong>? This cannot be undone.</p>
        )}
      </Modal>
    </tbody>
  );
};
