import React, { useEffect, useRef, useState } from 'react';
import { Flow, FlowRunState, StepRunState } from '@ai-stepflow/core/types';
import { Icon, metaValue } from '../components/primitives';
import { formatRunTime, getStepSkills, getFlowColumns } from '../flowUtils';
import { sendToVSCode } from '../vscode';
import { FlowGraphCanvas } from '../components/FlowGraphCanvas';

/** ms between two ISO timestamps, or 0 if either is missing/invalid. */
function spanMs(from?: string, to?: string): number {
  if (!from || !to) return 0;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** Human-readable duration: "450ms", "12s", "1m 23s", "2h 5m". */
function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

interface InlineRunnerProps {
  flow: Flow;
  runState: FlowRunState;
  auditLogs: Record<string, any[]>;
  activeStepId: string | null;
  completedSteps: number;
  activeProgress: number;
  commandCopied: boolean;
  onSetActiveStep: (id: string) => void;
  onRunStep: (stepId: string, description: string) => void;
  onOpenFile: (path: string) => void;
  onCopyCommand: () => void;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
}

export const InlineRunner: React.FC<InlineRunnerProps> = ({
  flow,
  runState,
  auditLogs,
  activeStepId,
  completedSteps,
  commandCopied,
  onSetActiveStep,
  onRunStep,
  onOpenFile,
  onCopyCommand,
  outputEndRef,
}) => {
  const activeStep = flow.steps.find(step => step.id === activeStepId);
  const activeStepState = activeStepId ? runState.steps[activeStepId] : null;
  // An "auto" step is AI-reviewed; a "human" step waits for approve/reject. When the run's
  // auto-review is off, an auto step is not AI-reviewed — it waits for a plain "Finish" instead.
  const activeStepIsAuto = activeStep?.review.type === 'ai' || !!activeStep?.review.reviewers?.some(r => r.type === 'ai');
  const finishGate = activeStepIsAuto && !runState.autoReview;
  const stepCosts = flow.steps.map(step => {
    const isHeadless = false; // All steps run interactively now
    return {
      step,
      state: runState.steps[step.id],
      costUsd: runState.steps[step.id]?.costUsd ?? 0,
      tokensUsed: runState.steps[step.id]?.tokensUsed ?? 0,
      taskMs: spanMs(runState.steps[step.id]?.startedAt, runState.steps[step.id]?.completedAt),
      reviewMs: spanMs(runState.steps[step.id]?.completedAt, runState.steps[step.id]?.reviewCompletedAt),
      isHeadless
    };
  });
  const totalCostUsd = stepCosts.reduce((sum, item) => sum + item.costUsd, 0);
  const totalTokens = stepCosts.reduce((sum, item) => sum + item.tokensUsed, 0);
  const totalTaskMs = stepCosts.reduce((sum, item) => sum + item.taskMs, 0);
  const totalReviewMs = stepCosts.reduce((sum, item) => sum + item.reviewMs, 0);
  const hasAnyHeadlessStep = false; // All steps run interactively now
  const reviewStatus = activeStepState?.reviewStatus;
  const aiReviewing = reviewStatus === 'ai_review_running';
  // All steps run interactively in the terminal; the in-flight run is cancelled by disposing it.
  const isHeadless = false;

  const stepActions = (() => {
    const actions = {
      showRun: false,
      showRerun: false,
      showReview: false,
      showFinish: false,
      showWorking: false,
      showCancel: false,
      isLocked: false
    };

    if (!activeStepState) return actions;

    const { executionStatus, reviewStatus, completionStatus, history } = activeStepState;
    const hasRunBefore = (history?.length ?? 0) > 0;

    if (executionStatus === 'locked') {
      actions.isLocked = true;
    } else if (completionStatus === 'done') {
      // Once fully done, only re-run is allowed
      actions.showRerun = true;
    } else if (executionStatus === 'running') {
      // AI is actively working. Show a working indicator + Stop; the review actions only
      // appear once the run completes (AI review runs, or a human-review step reaches its
      // approval gate), so the user is never asked to judge a result that doesn't exist yet.
      actions.showWorking = true;
      actions.showCancel = true;
    } else if (reviewStatus === 'waiting_human') {
      // Terminal closed, waiting for the user. An auto step with the run's auto-review off just
      // needs a plain "Finish"; a human-review step gets approve/reject.
      if (finishGate) actions.showFinish = true;
      else actions.showReview = true;
      actions.showRerun = true;
    } else {
      // Fallback for terminal states without a review gate (ready, failed, cancelled, rejected)
      if (hasRunBefore) actions.showRerun = true;
      else actions.showRun = true;
    }

    return actions;
  })();

  // A step's true state spans three axes (execution / review / completion); the badge collapses
  // them into one label, mirroring aidlc's StatusBadge. Order matters — the most final/specific
  // state wins (done > failed/rejected > running > review gate > ready/locked).
  const stepStatusBadge = (state: StepRunState | null | undefined) => {
    if (!state) return null;
    const { executionStatus, reviewStatus, completionStatus } = state;
    if (completionStatus === 'done') return <span className="badge success"><Icon.Check size={10} style={{ marginRight: 4 }} />done</span>;
    if (executionStatus === 'failed') return <span className="badge error"><Icon.X size={10} style={{ marginRight: 4 }} />failed</span>;
    if (reviewStatus === 'rejected') return <span className="badge error"><Icon.X size={10} style={{ marginRight: 4 }} />rejected</span>;
    if (reviewStatus === 'approved') return <span className="badge success"><Icon.Check size={10} style={{ marginRight: 4 }} />approved</span>;
    if (executionStatus === 'running') return <span className="badge progress"><Icon.Play size={10} style={{ marginRight: 4 }} />running</span>;
    if (reviewStatus === 'ai_review_running') return <span className="badge progress"><Icon.RotateCw size={10} style={{ marginRight: 4 }} className="spin" />reviewing</span>;
    if (reviewStatus === 'waiting_human' || executionStatus === 'completed') return <span className="badge warning"><Icon.Info size={10} style={{ marginRight: 4 }} />waiting review</span>;
    if (executionStatus === 'cancelled') return <span className="badge">cancelled</span>;
    if (executionStatus === 'locked') return <span className="badge"><Icon.Lock size={10} style={{ marginRight: 4 }} />locked</span>;
    if (executionStatus === 'ready') return <span className="badge">ready</span>;
    return null;
  };

  const flowHistory = (auditLogs[flow.id] || [])
    .filter(event => event.stepId === activeStepId && event.runId === runState.runId)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Each "Start run" produces a distinct runId, so the history is grouped by run.
  // flowHistory is already newest-first, so groups land newest-run-first and events
  // stay newest-first within each group.
  const historyGroups: { runId: string; events: any[] }[] = [];
  const groupByRunId = new Map<string, any[]>();
  for (const event of flowHistory) {
    const runId = event.runId || 'unknown';
    let events = groupByRunId.get(runId);
    if (!events) {
      events = [];
      groupByRunId.set(runId, events);
      historyGroups.push({ runId, events });
    }
    events.push(event);
  }

  const completionStatuses = Object.values(runState.steps).map(s => s.completionStatus);

  // Overall run status (summarized from steps).
  const getRunStatus = () => {
    const statuses = Object.values(runState.steps).map(s => s.executionStatus);
    if (completionStatuses.every(s => s === 'done')) return { label: 'Done', className: 'success', Icon: Icon.Check };
    if (statuses.includes('failed')) return { label: 'Failed', className: 'error', Icon: Icon.X };
    if (statuses.includes('running')) return { label: 'Running', className: 'progress', Icon: Icon.Play };
    if (statuses.includes('cancelled')) return { label: 'Cancelled', className: '', Icon: Icon.Info };
    return { label: 'Ready', className: '', Icon: Icon.Info };
  };

  const runStatus = getRunStatus();
  const isFlowDone = completionStatuses.every(s => s === 'done');
  const isFinalized = !!runState.isClosed;
  
  // Reset is available once any step has moved past its initial ready/locked state.
  const canResetRun = !isFinalized && Object.values(runState.steps).some(
    s => s.executionStatus !== 'ready' && s.executionStatus !== 'locked'
  );

  // A single step can be reset once it has left its pristine initial state (ready/locked with no
  // history) — the escape hatch for a step wedged in a state with no valid action (e.g. no Finish).
  const canResetStep = !isFinalized && !!activeStepState && !(
    (activeStepState.executionStatus === 'ready' || activeStepState.executionStatus === 'locked')
    && (activeStepState.history?.length ?? 0) === 0
  );

  // Auto-review is a pre-run policy: lock it the moment any step has started, since a step
  // already running under one policy can't have that policy flipped mid-flight. "Started" = has
  // history, or has left its pristine ready/locked execution state.
  const autoReviewLocked = Object.values(runState.steps).some(
    s => (s.history?.length ?? 0) > 0 || (s.executionStatus !== 'ready' && s.executionStatus !== 'locked')
  );

  // Secondary run actions (Reset / Verify / Report / Delete) collapse into a single "more" menu
  // to keep the header uncluttered.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  // Approve/Reject/Finish can wait on a real Claude call (semantic produces check, AI review)
  // before the extension replies, so spin the clicked button until that step's state actually
  // changes (success) or an error is posted back (failure) — both replace `activeStepState`.
  const [pendingAction, setPendingAction] = useState<'approve' | 'reject' | null>(null);
  useEffect(() => {
    setPendingAction(null);
  }, [activeStepId, activeStepState]);

  // Runner content is split into sub-tabs to cut vertical scrolling: the step detail head
  // (status + actions) stays pinned; Graph / Cost analysis / Output / History switch below it.
  const [rtab, setRtab] = useState<'graph' | 'cost' | 'output' | 'history'>('graph');
  const canvasRef = useRef<HTMLDivElement>(null);
  const columns = getFlowColumns(flow);

  return (
    <div className="runner">
      <div className="runner-head">
        <div className="runner-head-info">
          {isFinalized ? (
            <span className="badge success">
              <Icon.Check size={10} style={{ marginRight: 4 }} />
              Finalized
            </span>
          ) : (
            <span className={`badge ${runStatus.className}`}>
              <runStatus.Icon size={10} style={{ marginRight: 4 }} />
              {runStatus.label}
            </span>
          )}
          <span className="runner-flow-name">
            {runState.runName || runState.runId.split('T')[0]}
          </span>
          <span className="small muted">
            {completedSteps}/{flow.steps.length} steps done · {formatRunTime(runState.runId)}
          </span>
        </div>
        <div className="runner-head-actions">
          {!isFinalized && (
            <>
              <label
                className={`auto-review-toggle small${autoReviewLocked ? ' is-disabled' : ''}`}
                title={autoReviewLocked
                  ? 'Auto review is locked once a step has run. Reset the run to change it.'
                  : 'On: AI reviews each auto step\'s artifact — pass advances automatically, a rejection stops the run and writes a review report. Off: no AI review runs; each auto step waits for you to click "Finish Step". Human-review steps always wait for your approval either way.'}
              >
                <input
                  type="checkbox"
                  role="switch"
                  checked={!!runState.autoReview}
                  disabled={autoReviewLocked}
                  onChange={e => sendToVSCode('setAutoReview', { enabled: e.target.checked })}
                />
                <span className="switch-track" aria-hidden="true" />
                <span>Auto review</span>
              </label>
              <span className="runner-head-divider" aria-hidden="true" />
            </>
          )}
          {!isFinalized && isFlowDone && (
            <button
              className="btn success"
              title="Finalize flow and clear active status"
              onClick={() => sendToVSCode('closeRun', { finalize: true })}
            >
              <Icon.Check size={14} style={{ marginRight: 4 }} />
              Done Run
            </button>
          )}
          {!isFinalized && (
            <div className="more-menu" ref={menuRef}>
              <button
                className="icon-btn"
                title="More actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(open => !open)}
              >
                <Icon.More size={16} />
              </button>
              {menuOpen && (
                <div className="more-menu-list" role="menu">
                  {!isFlowDone && canResetRun && (
                    <button className="more-menu-item" role="menuitem" onClick={() => { setMenuOpen(false); sendToVSCode('resetRun', {}); }}>
                      <Icon.RotateCw size={14} />Reset all steps
                    </button>
                  )}
                  <button className="more-menu-item" role="menuitem" onClick={() => { setMenuOpen(false); sendToVSCode('verifyRun', {}); }}>
                    <Icon.Check size={14} />Verify
                  </button>
                  <button className="more-menu-item" role="menuitem" onClick={() => { setMenuOpen(false); sendToVSCode('exportRunReport', {}); }}>
                    <Icon.Copy size={14} />Report
                  </button>
                  <div className="more-menu-sep" />
                  <button className="more-menu-item danger" role="menuitem" onClick={() => { setMenuOpen(false); sendToVSCode('deleteRun', {}); }}>
                    <Icon.Trash2 size={14} />Delete run
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            className="icon-btn"
            title="Close runner view (keep run data)"
            onClick={() => sendToVSCode('closeRun', { finalize: false })}
          >
            <Icon.X size={14} />
          </button>
        </div>
      </div>
      <div className="runner-detail">
        <div className="runner-detail-head">
          <div className="runner-detail-title">
            <span className="runner-detail-step-label">
              Step {activeStep ? flow.steps.findIndex(step => step.id === activeStep.id) + 1 : '–'} / {flow.steps.length}
            </span>
            <div className="runner-detail-title-row">
              <span className="runner-detail-step-title">
                {activeStep ? activeStep.title || activeStep.id : 'No step selected'}
              </span>
              {stepStatusBadge(activeStepState)}
            </div>
          </div>
          <div className="runner-detail-actions">
            {!isFinalized && (
              <>
                {stepActions.showWorking && (
                  <span className="badge progress">
                    <Icon.RotateCw size={10} style={{ marginRight: 4 }} className="spin" />
                    AI working…
                  </span>
                )}
                {aiReviewing && (
                  <span className="badge progress">
                    <Icon.RotateCw size={10} style={{ marginRight: 4 }} className="spin" />
                    AI reviewing…
                  </span>
                )}

                {stepActions.showCancel && (
                  <button className="btn error" title="Stop the running step" onClick={() => sendToVSCode('cancelStep', { stepId: activeStepId! })}>
                    <span className="btn-glyph"><Icon.X size={14} /></span>Stop
                  </button>
                )}
                {stepActions.showRun && (
                  <button className="btn primary" title="Run this step" onClick={() => onRunStep(activeStepId!, '')}>
                    <span className="btn-glyph"><Icon.Play size={14} /></span>Run Step
                  </button>
                )}
                {stepActions.showFinish && (
                  <button className="btn primary" title="Finish this step and continue to the next" disabled={pendingAction !== null} onClick={() => {
                    setPendingAction('approve');
                    sendToVSCode('reviewStep', { stepId: activeStepId!, decision: 'approved' });
                  }}>
                    {pendingAction === 'approve' ? <span className="btn-glyph"><Icon.RotateCw size={14} className="spin" /></span> : <span className="btn-glyph"><Icon.Check size={14} /></span>}Finish Step
                  </button>
                )}
                {stepActions.showReview && (
                  <>
                    {activeStep?.review.filePath && (
                      <button className="btn" title={activeStep.review.filePath} onClick={() => onOpenFile(activeStep.review.filePath!)}>Open review file</button>
                    )}
                    <button className="btn success" title="Approve this step" disabled={pendingAction !== null} onClick={() => {
                      setPendingAction('approve');
                      sendToVSCode('reviewStep', { stepId: activeStepId!, decision: 'approved' });
                    }}>
                      {pendingAction === 'approve' && <span className="btn-glyph"><Icon.RotateCw size={14} className="spin" /></span>}Approve
                    </button>
                    <button className="btn error" title="Reject this step" disabled={pendingAction !== null} onClick={() => {
                      setPendingAction('reject');
                      sendToVSCode('reviewStep', { stepId: activeStepId!, decision: 'rejected' });
                    }}>
                      {pendingAction === 'reject' && <span className="btn-glyph"><Icon.RotateCw size={14} className="spin" /></span>}Reject
                    </button>
                  </>
                )}
                {stepActions.showRerun && (
                  <button className="btn" title="Re-run this step" onClick={() => onRunStep(activeStepId!, '')}>
                    <span className="btn-glyph"><Icon.RotateCw size={14} /></span>Re-run
                  </button>
                )}
                {stepActions.isLocked && <button className="btn" disabled title="Complete the steps this one depends on first">Locked</button>}
                {canResetStep && (
                  <button className="btn" title="Reset this step to its initial state so it can be run again" onClick={() => sendToVSCode('resetStep', { stepId: activeStepId! })}>
                    <span className="btn-glyph"><Icon.RotateCw size={14} /></span>Reset Step
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        <div className="subtabs">
          <button className={`subtab ${rtab === 'graph' ? 'on' : ''}`} onClick={() => setRtab('graph')}><Icon.GraphIcon size={13} /> Graph</button>
          <button className={`subtab ${rtab === 'cost' ? 'on' : ''}`} onClick={() => setRtab('cost')}><Icon.Chart size={13} /> Cost analysis</button>
          <button className={`subtab ${rtab === 'output' ? 'on' : ''}`} onClick={() => setRtab('output')}><Icon.Terminal size={13} /> Output</button>
          <button className={`subtab ${rtab === 'history' ? 'on' : ''}`} onClick={() => setRtab('history')}><Icon.Clock size={13} /> History</button>
        </div>

        {rtab === 'graph' && (
          <div className="subpane">
            <div className="canvas" ref={canvasRef}>
              <FlowGraphCanvas steps={flow.steps} containerRef={canvasRef} isExpanded={true} />
              <div className="nodes">
                {columns.map((column, columnIndex) => (
                  <div className={`col${column.length > 1 ? ' branch' : ''}`} key={`${flow.id}-rc-${columnIndex}`}>
                    {column.map((step, rowIndex) => {
                      const stepNumber = column.length > 1 ? `${columnIndex + 1}.${rowIndex + 1}` : `${columnIndex + 1}`;
                      const st = runState.steps[step.id];
                      const isDone = st?.completionStatus === 'done';
                      const isActive = activeStepId === step.id;
                      const isRunning = st?.executionStatus === 'running';
                      const reviewAi = step.review.type === 'ai';
                      const skills = getStepSkills(step);
                      const canRerun = !isFinalized && st && st.executionStatus !== 'locked';
                      const canReset = !isFinalized && !!st && !(
                        (st.executionStatus === 'ready' || st.executionStatus === 'locked') && (st.history?.length ?? 0) === 0
                      );
                      return (
                        <div
                          key={step.id}
                          id={`step-node-${step.id}`}
                          className={`node${isDone ? ' done' : ''}${isActive ? ' active' : ''}${isRunning ? ' hot' : ''}`}
                          onClick={() => onSetActiveStep(step.id)}
                        >
                          <div className="nt">
                            <span className="ni">{isDone ? <Icon.Check size={11} /> : stepNumber}</span>
                            <span className="nn">{step.title || step.id}</span>
                            <span className={`rv ${reviewAi ? 'ai' : 'human'}`}>{reviewAi ? 'AI' : 'Human'}</span>
                          </div>
                          <div className="meta">
                            <span>{step.agent || 'unassigned'}</span>
                            <span>{skills.length ? skills.map(s => `/${s}`).join(' ') : '—'}</span>
                          </div>
                          <div className="stat">
                            {st?.tokensUsed ? `${st.tokensUsed.toLocaleString()} · ` : ''}
                            {st?.costUsd ? `$${st.costUsd.toFixed(2)} · ` : ''}
                            {st?.executionStatus || 'ready'}
                          </div>
                          <div className="acts">
                            {canRerun && (
                              <button type="button" className="na reset" title="Re-run this step" onClick={e => { e.stopPropagation(); onRunStep(step.id, ''); }}><Icon.RotateCw size={12} />Re-run</button>
                            )}
                            {canReset && (
                              <button type="button" className="na reset" title="Reset this step" onClick={e => { e.stopPropagation(); sendToVSCode('resetStep', { stepId: step.id }); }}>Reset</button>
                            )}
                            <button type="button" className="na" title="Show output" onClick={e => { e.stopPropagation(); onSetActiveStep(step.id); setRtab('output'); }}><Icon.List size={12} /></button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {rtab === 'output' && (<>
        <div className="runner-meta">
          <div className="meta-group">
            <span className="muted small">agent</span>
            {metaValue(activeStep?.agent, 'no agent assigned', true)}
            <span className="muted small">skill</span>
            {metaValue(activeStep ? getStepSkills(activeStep).join(', ') : '', 'no skill assigned', true)}
            <span className="muted small">command</span>
            <span className="mono small command-cell">
              {activeStep && getStepSkills(activeStep).length ? getStepSkills(activeStep).map(name => `/${name}`).join(' · ') : '/skill'}
              <button
                className="icon-btn sm"
                title={commandCopied ? 'Copied!' : 'Copy command'}
                onClick={onCopyCommand}
              >
                {commandCopied ? <Icon.Check size={14} /> : <Icon.Copy size={14} />}
              </button>
            </span>
          </div>
          <div className="meta-group">
            <span className="muted small">input</span>
            {metaValue(Object.entries(runState.inputs || {}).map(([key, value]) => `${key}=${value}`).join(' · '), 'no run inputs')}
            <span className="muted small">model</span>
            {metaValue(activeStepState?.modelUsed, 'not reported yet', true)}
            <span className="muted small">tokens</span>
            {metaValue(activeStepState?.tokensUsed != null ? activeStepState.tokensUsed.toLocaleString() : '', 'not reported yet', true)}
            <span className="muted small">cost</span>
            {metaValue(activeStepState?.costUsd != null ? `$${activeStepState.costUsd.toFixed(4)}` : '', 'not reported yet', true)}
            <span className="muted small">task time</span>
            {metaValue(spanMs(activeStepState?.startedAt, activeStepState?.completedAt) > 0 ? formatDuration(spanMs(activeStepState?.startedAt, activeStepState?.completedAt)) : '', 'not reported yet', true)}
          </div>
        </div>
        <div className="console-wrap">
          <div className="divider-label">Output</div>
          <pre className="console">
            {activeStepState?.output || (activeStep ? 'Waiting for run command...' : 'No active step selected.')}
            <div ref={outputEndRef} />
          </pre>
        </div>

        {activeStepState?.aiReviewOutput && (
          <div className="console-wrap">
            <div className="divider-label">AI Review</div>
            <pre className="console ai-review">{activeStepState.aiReviewOutput}</pre>
          </div>
        )}
        {reviewStatus === 'approved' && (
          <div className="result-banner success">
            <Icon.Check size={13} /> Approved — step will advance automatically.
          </div>
        )}
        {reviewStatus === 'rejected' && (
          <div className="result-banner error">
            <Icon.X size={13} /> Rejected — fix the issues and re-run the step.
          </div>
        )}
        {reviewStatus === 'waiting_human' && finishGate && (
          <div className="result-banner warning">
            <Icon.Info size={13} /> Auto review is off for this run — no AI review ran. Check the artifact, then click Finish Step to continue.
          </div>
        )}
        {reviewStatus === 'waiting_human' && !finishGate && activeStep?.review.type === 'ai' && (
          <div className="result-banner warning">
            <Icon.Info size={13} /> Auto review couldn't decide automatically — approve or reject manually. {activeStepState?.aiReviewOutput ? 'See the AI Review log above for the reason.' : 'Add a `produces` file to the step so the reviewer has something to read, or install the review kit.'}
          </div>
        )}

        </>)}

        {/* Step-scoped Execution History, grouped per run — lives inside the step detail. */}
        {rtab === 'history' && (historyGroups.length > 0 ? (
          <div className="step-history">
            <div className="divider-label mb-4">Execution History</div>
            {historyGroups.map(group => (
              <div key={group.runId} className="history-run-group">
                <div className="history-run-head small">
                  <span className="muted mono">{group.runId === 'unknown' ? 'unknown run' : formatRunTime(group.runId)}</span>
                </div>
                <div className="timeline">
                  {group.events.map((event, i) => {
                    const isSuccess = event.status === 'completed' || event.status === 'approved' || event.status.includes('approved');
                    const isError = event.status === 'failed' || event.status === 'rejected' || event.status.includes('rejected');
                    const isRunning = event.status === 'running' || event.status.includes('running');

                    let StatusIcon = Icon.Info;
                    if (isSuccess) StatusIcon = Icon.Check;
                    if (isError) StatusIcon = Icon.X;
                    if (isRunning) StatusIcon = Icon.Play;

                    return (
                      <div key={i} className={`timeline-item ${isSuccess ? 'success' : isError ? 'error' : isRunning ? 'running' : ''}`}>
                        <div className="timeline-dot" />
                        <div className="timeline-content">
                          <div className="timeline-time">{new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
                          <div className="timeline-body">
                            <div className={`timeline-status ${isSuccess ? 'success' : isError ? 'error' : isRunning ? 'running' : ''}`}>
                              <StatusIcon size={12} />
                              {event.status}
                            </div>
                            {event.message && <div className="timeline-message">{event.message}</div>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : <div className="run-empty">No execution history yet.</div>)}

        {rtab === 'cost' && (
        <div className="runner-costs">
          <div className="divider-label">Cost Analysis</div>
          <div className="runner-costs-head">
            <div className="small muted">
              {totalCostUsd > 0
                ? `Total $${totalCostUsd.toFixed(4)} · ${totalTokens.toLocaleString()} tokens`
                : totalTokens > 0
                  ? `Total — · ${totalTokens.toLocaleString()} tokens`
                  : hasAnyHeadlessStep
                    ? 'Cost data available after AI-executed steps complete'
                    : 'Interactive steps — no token tracking'}
              {totalTaskMs > 0 && ` · task ${formatDuration(totalTaskMs)}`}
              {totalReviewMs > 0 && ` · review ${formatDuration(totalReviewMs)}`}
            </div>
          </div>
          <table className="runner-cost-table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Status</th>
                <th>Model</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Task Time</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {stepCosts.map(({ step, state, costUsd, tokensUsed, taskMs, isHeadless }) => {
                const share = totalCostUsd > 0 ? (costUsd / totalCostUsd) * 100 : 0;
                const hasRun = state?.executionStatus !== 'ready' && state?.executionStatus !== 'locked' && state?.executionStatus != null;
                const isRunning = state?.executionStatus === 'running';
                const modelLabel = state?.modelUsed
                  || (isRunning ? '…' : hasRun && !isHeadless ? 'interactive' : '—');
                return (
                  <tr key={step.id} className={activeStepId === step.id ? 'active' : ''}>
                    <td>{step.title || step.id}</td>
                    <td>{state?.executionStatus || 'ready'}</td>
                    <td className={!state?.modelUsed && hasRun && !isHeadless ? 'muted' : ''}>{modelLabel}</td>
                    <td>{tokensUsed > 0 ? tokensUsed.toLocaleString() : isRunning ? '…' : '—'}</td>
                    <td>{costUsd > 0 ? `$${costUsd.toFixed(4)}` : isRunning ? '…' : '—'}</td>
                    <td>{taskMs > 0 ? formatDuration(taskMs) : isRunning ? '…' : '—'}</td>
                    <td style={{ minWidth: '100px' }}>
                      {costUsd > 0 ? (
                        <div className="cost-bar-wrapper" title={`${share.toFixed(1)}%`}>
                          <div className="cost-bar-track">
                            <div className="cost-bar-fill" style={{ width: `${share}%` }} />
                          </div>
                          <span className="cost-bar-label">{share.toFixed(1)}%</span>
                        </div>
                      ) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )}

      </div>
    </div>
  );
};
