import React, { useState, useEffect, useRef } from 'react';
import { Flow, FlowRunState } from '@ai-stepflow/core/types';
import { Icon, Modal } from '../components/primitives';
import { getFlowColumns, getStepSkills } from '../flowUtils';
import { sendToVSCode } from '../vscode';
import { InlineRunner } from './InlineRunner';
import { FlowGraphCanvas } from '../components/FlowGraphCanvas';

type RunSummary = {
  flowId: string; runId: string; runName?: string;
  completedSteps: number; totalSteps: number; mtimeMs: number; isClosed: boolean;
  costUsd?: number; tokensUsed?: number; taskTimeMs?: number; reviewTimeMs?: number;
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

const fmtUsd = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}K` : `${n}`);
const fmtDur = (ms: number): string => {
  if (ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

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
              <div className="canvas" ref={canvasRef}>
                <FlowGraphCanvas steps={flow.steps} containerRef={canvasRef} isExpanded={graphOpen} />
                <div className="nodes">
                  {columns.map((column, columnIndex) => (
                    <div className={`col${column.length > 1 ? ' branch' : ''}`} key={`${flow.id}-${columnIndex}`}>
                      {column.map((step, rowIndex) => {
                        const stepNumber = column.length > 1 ? `${columnIndex + 1}.${rowIndex + 1}` : `${columnIndex + 1}`;
                        const reviewAi = step.review.type === 'ai';
                        const stepIndex = flow.steps.findIndex(s => s.id === step.id);
                        const skills = getStepSkills(step);
                        const deps = (step.dependsOn || [])
                          .map(id => flow.steps.find(s => s.id === id)?.title || id)
                          .join(', ') || '—';
                        return (
                          <div key={step.id} id={`step-node-${step.id}`} className="node">
                            <div className="nt">
                              <span className="ni">{stepNumber}</span>
                              <span className="nn">{step.title || step.id}</span>
                              <span className={`rv ${reviewAi ? 'ai' : 'human'}`}>{reviewAi ? 'AI' : 'Human'}</span>
                            </div>
                            <div className="meta">
                              <span>agent: {step.agent || 'unassigned'}</span>
                              <span>skill: {skills.length ? skills.map(s => `/${s}`).join(' ') : '—'}</span>
                            </div>
                            <div className="stat">depends on: {deps}</div>
                            <div className="acts">
                              <button type="button" className="na" title="Edit step" onClick={e => { e.stopPropagation(); onBoardStepEditor(flow, stepIndex); }}><Icon.Settings size={12} />Edit</button>
                              <button type="button" className="na reset" title="Remove step" onClick={e => { e.stopPropagation(); setConfirmRemoveIndex(stepIndex); }}><Icon.X size={13} /></button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  <div className="col" style={{ justifyContent: 'center' }}>
                    <button type="button" className="flow-add-node" onClick={() => onBoardStepAdder(flow)} aria-label="Add workflow step"><Icon.Plus size={14} /></button>
                  </div>
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
                <div className="runs-tbl scroll-x">
                  <table>
                    <thead><tr>
                      <th style={{ width: '4%' }} />
                      <th style={{ width: '28%' }}>Run</th>
                      <th style={{ width: '12%' }}>Status</th>
                      <th style={{ width: '9%' }}>Progress</th>
                      <th style={{ width: '9%' }}>Tokens</th>
                      <th style={{ width: '8%' }}>Cost</th>
                      <th style={{ width: '11%' }}>Task time</th>
                      <th style={{ width: '10%' }}>Started</th>
                      <th style={{ width: '9%' }} />
                    </tr></thead>
                    <tbody>
                      {[...runSummaries].sort((a, b) => b.mtimeMs - a.mtimeMs).map(s => {
                        const isOpen = runnerOpen && runState?.runId === s.runId;
                        return (
                          <React.Fragment key={s.runId}>
                            <tr
                              className={`run-row ${isOpen ? 'sel open' : ''}`}
                              onClick={() => sendToVSCode('switchRun', { flowId: flow.id, runId: s.runId })}
                            >
                              <td><span className="rchev"><Icon.ChevronRight size={14} /></span></td>
                              <td><strong>{s.runName || s.runId.split('T')[0]}</strong> <span className="mono" style={{ color: 'var(--text-faint)' }}>#{s.runId.slice(-4)}</span></td>
                              <td>{runStatusBadge(s)}</td>
                              <td className="mono num">{s.completedSteps} / {s.totalSteps}</td>
                              <td className="mono num">{s.tokensUsed ? fmtTokens(s.tokensUsed) : '—'}</td>
                              <td className="mono num">{s.costUsd ? fmtUsd(s.costUsd) : '—'}</td>
                              <td className="mono num">{s.taskTimeMs ? fmtDur(s.taskTimeMs) : '—'}</td>
                              <td className="when">{fmtAgo(s.mtimeMs)}</td>
                              <td className="actions-cell">
                                <span className="row-actions">
                                  <button className="icon-btn" title="Export report" onClick={e => { e.stopPropagation(); sendToVSCode('exportRunReport', { flowId: flow.id, runId: s.runId }); }}><Icon.Copy size={14} /></button>
                                  {!s.isClosed && (
                                    <button className="icon-btn" title="Reset all steps" onClick={e => { e.stopPropagation(); sendToVSCode('resetRun', { flowId: flow.id, runId: s.runId }); }}><Icon.RotateCw size={14} /></button>
                                  )}
                                  <button className="icon-btn danger" title="Delete run" onClick={e => { e.stopPropagation(); sendToVSCode('deleteRun', { flowId: flow.id, runId: s.runId }); }}><Icon.Trash2 size={14} /></button>
                                </span>
                              </td>
                            </tr>
                            {isOpen && runState && (
                              <tr className="run-detail-row">
                                <td colSpan={9}>
                                  <div className="run-detail">
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
