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
  costUsd?: number; tokensUsed?: number; taskTimeMs?: number; failedSteps?: number;
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
  onEditRun: () => void;
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

const fmtDur = (ms?: number): string => {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
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
  onEditRun,
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
  const [runsOpen, setRunsOpen] = useState(false);
  const [runsTab, setRunsTab] = useState<'running' | 'done'>('running');
  const [confirmRemoveIndex, setConfirmRemoveIndex] = useState<number | null>(null);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const runMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!runnerOpen) return;
    // Surface the open run: switch to the tab that contains it.
    const s = runSummaries.find(r => r.runId === runState?.runId);
    if (s) setRunsTab(isFinished(s) ? 'done' : 'running');
  }, [runnerOpen, runState?.runId]);
  useEffect(() => {
    if (!runMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (runMenuRef.current && !runMenuRef.current.contains(e.target as Node)) setRunMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [runMenuOpen]);

  // Run-level actions target the currently-open run, so they render on that row only.
  const activeSteps = runnerOpen && runState ? Object.values(runState.steps) : [];
  const runFinalized = !!runState?.isClosed;
  const runFlowDone = activeSteps.length > 0 && activeSteps.every(s => s.completionStatus === 'done');
  const runCanReset = !runFinalized && activeSteps.some(s => s.executionStatus !== 'ready' && s.executionStatus !== 'locked');
  // Editing the run name/inputs is only safe before any step has started — after that they'd be out
  // of sync with the output slug + resolved artifact paths. Mirrors the backend pristine guard.
  const runCanEdit = !runFinalized && activeSteps.length > 0
    && activeSteps.every(s => (s.executionStatus === 'ready' || s.executionStatus === 'locked') && !(s.history?.length));

  const activeRuns = runSummaries.filter(s => !s.isClosed);
  // A run is "finished" once finalized or all its steps completed; everything else is still running.
  const isFinished = (s: RunSummary) => s.isClosed || s.completedSteps >= s.totalSteps;
  const runningRuns = runSummaries.filter(s => !isFinished(s)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const doneRuns = runSummaries.filter(isFinished).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const total = flow.steps.length;

  // Flow-level status reflects only whether a run is active — "Done" is a per-run state, not a flow state.
  let statusKey: 'run' | 'idle' = 'idle';
  let statusLabel = 'Ready';
  if (runnerOpen && runState) { statusKey = 'run'; statusLabel = 'Running'; }
  else if (activeRuns.length > 0) { statusKey = 'run'; statusLabel = 'In progress'; }

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

  const renderRunRow = (s: RunSummary) => {
    const isActive = runnerOpen && runState?.runId === s.runId;
    const done = s.completedSteps >= s.totalSteps;
    const failed = (s.failedSteps ?? 0) > 0;
    const statusKey = s.isClosed ? 'done' : failed ? 'fail' : done ? 'ok' : 'run';
    const statusLabel = s.isClosed ? 'Finalized' : failed ? 'Failed' : done ? 'Done' : 'Running';
    return (
      <React.Fragment key={s.runId}>
        <tr
          className={`run-row ${isActive ? 'open' : ''} ${statusKey === 'run' ? 'live' : ''}`}
          title={new Date(s.mtimeMs).toLocaleString()}
        >
          <td className="rt-status">
            <span className={`run-status ${statusKey === 'run' || statusKey === 'fail' ? '' : 'muted'}`}>
              <span className={`ddot ${statusKey}`} />
              <span>{statusLabel}</span>
            </span>
          </td>
          <td className="rt-name">
            <span className="run-name">{s.runName || s.runId.split('T')[0]}</span>
            <span className="run-id mono">·{s.runId.slice(-6)}</span>
          </td>
          <td className="rt-cost mono">{s.costUsd && s.costUsd > 0 ? `$${s.costUsd.toFixed(2)}` : '—'}</td>
          <td className="rt-tokens mono">{s.tokensUsed && s.tokensUsed > 0 ? s.tokensUsed.toLocaleString() : '—'}</td>
          <td className="rt-task mono">{fmtDur(s.taskTimeMs)}</td>
          <td className="rt-progress">
            <span className="pipe">
              {Array.from({ length: s.totalSteps }).map((_, i) => {
                const cls = i < s.completedSteps ? 'done'
                  : i === s.completedSteps && failed && !s.isClosed ? 'fail'
                  : i === s.completedSteps && !done && !s.isClosed ? 'active'
                  : '';
                return <span key={i} className={`seg ${cls}`} />;
              })}
              <span className="pipe-num">{s.completedSteps}/{s.totalSteps}</span>
            </span>
          </td>
          <td className="rt-started">{fmtAgo(s.mtimeMs)}</td>
          <td className="rt-actions" onClick={e => e.stopPropagation()}>
            <div className="run-row-actions">
              <button
                className="icon-btn"
                title={isActive ? 'Close run details' : 'Open run details'}
                aria-label={isActive ? 'Close run details' : 'Open run details'}
                aria-expanded={isActive}
                onClick={() => sendToVSCode(isActive ? 'closeRun' : 'switchRun', isActive ? { finalize: false } : { flowId: flow.id, runId: s.runId })}
              >
                {isActive ? <Icon.ChevronDown size={16} /> : <Icon.ChevronRight size={16} />}
              </button>
              {isActive && !runFinalized && (
                <>
                {runFlowDone && (
                  <button className="btn success" title="Finalize run — mark it done and clear the active status" onClick={() => sendToVSCode('closeRun', { finalize: true })}>
                    <Icon.Check size={14} />Done
                  </button>
                )}
                <div className="more-menu" ref={runMenuRef}>
                  <button className="icon-btn" title="More actions" aria-haspopup="menu" aria-expanded={runMenuOpen} onClick={() => setRunMenuOpen(o => !o)}>
                    <Icon.More size={16} />
                  </button>
                  {runMenuOpen && (
                    <div className="more-menu-list" role="menu">
                      {runCanEdit && (
                        <button className="more-menu-item" role="menuitem" title="Edit this run's name and inputs (only before any step has started)" onClick={() => { setRunMenuOpen(false); onEditRun(); }}>
                          <Icon.Pencil size={14} />Edit name & inputs
                        </button>
                      )}
                      {!runFlowDone && runCanReset && (
                        <button className="more-menu-item" role="menuitem" onClick={() => { setRunMenuOpen(false); sendToVSCode('resetRun', {}); }}>
                          <Icon.RotateCw size={14} />Reset all steps
                        </button>
                      )}
                      <button className="more-menu-item" role="menuitem" onClick={() => { setRunMenuOpen(false); sendToVSCode('verifyRun', {}); }}>
                        <Icon.Check size={14} />Verify
                      </button>
                      <button className="more-menu-item" role="menuitem" onClick={() => { setRunMenuOpen(false); sendToVSCode('exportRunReport', {}); }}>
                        <Icon.Copy size={14} />Report
                      </button>
                      <div className="more-menu-sep" />
                      <button className="more-menu-item danger" role="menuitem" onClick={() => { setRunMenuOpen(false); sendToVSCode('deleteRun', {}); }}>
                        <Icon.Trash2 size={14} />Delete run
                      </button>
                    </div>
                  )}
                </div>
                </>
              )}
            </div>
          </td>
        </tr>

        {isActive && runState && (
          <tr className="run-detail">
            <td colSpan={8}>
              <div className="run-drawer">
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
  };

  const rows = runsTab === 'running' ? runningRuns : doneRuns;

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
        <td className="name-cell">
          <div className="dname">
            <span className="dn">{flow.name}</span>
            <span className="dsub">{flow.description || 'No description.'}</span>
          </div>
        </td>
        <td className="mono muted">{runSummaries.length} {runSummaries.length === 1 ? 'run' : 'runs'}</td>
        <td>{scopeBadge}</td>
        <td className="mono muted">{total} {total === 1 ? 'step' : 'steps'}</td>
        <td className="mono muted">{fmtAgo(runSummaries.reduce((m, s) => Math.max(m, s.mtimeMs), 0))}</td>
        <td className="drow-actions-cell">
          <span className="drow-actions">
            <button className={`icon-btn ${runsOpen ? 'active' : ''}`} title="Runs" onClick={toggleRuns}>{runsOpen ? <Icon.Terminal size={14} /> : <Icon.List size={14} />}</button>
            <button className={`icon-btn ${graphOpen ? 'active' : ''}`} title="Flow graph" onClick={() => setGraphOpen(o => !o)}>{graphOpen ? <Icon.GitBranchMinus size={14} /> : <Icon.GitBranch size={14} />}</button>

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
          <td colSpan={7}>
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
          <td colSpan={7}>
            <div className="detail">
              <div className="detail-subhead">
                <div className="ov-scope-switch" role="tablist" aria-label="Runs filter">
                  <button className={`ov-scope-btn${runsTab === 'running' ? ' active' : ''}`} role="tab" aria-selected={runsTab === 'running'} onClick={() => setRunsTab('running')}>
                    <Icon.Zap size={14} />Running
                  </button>
                  <button className={`ov-scope-btn${runsTab === 'done' ? ' active' : ''}`} role="tab" aria-selected={runsTab === 'done'} onClick={() => setRunsTab('done')}>
                    <Icon.Check size={14} />Done
                  </button>
                </div>
                <button className="btn primary new-run-btn" title="New run" onClick={() => onRun(flow)}><Icon.Play size={13} />New run</button>
              </div>

              <div className="runs-table-wrap">
                <table className="runs-table">
                  <thead>
                    <tr>
                      <th className="rt-status">Status</th>
                      <th className="rt-run">Run</th>
                      <th className="rt-cost">Cost</th>
                      <th className="rt-tokens">Tokens</th>
                      <th className="rt-task">Task</th>
                      <th className="rt-progress">Steps</th>
                      <th className="rt-started">Started</th>
                      <th className="rt-actions"></th>
                    </tr>
                  </thead>
                  <tbody className={runnerOpen && runState && rows.some(s => s.runId === runState.runId) ? 'has-open' : ''}>
                    {rows.length === 0 ? (
                      <tr className="run-empty-row">
                        <td colSpan={8}>Không có data hiển thị</td>
                      </tr>
                    ) : (
                      rows.map(renderRunRow)
                    )}
                  </tbody>
                </table>
              </div>
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
