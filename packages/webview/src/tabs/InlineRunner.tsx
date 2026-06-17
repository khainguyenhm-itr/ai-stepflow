import React from 'react';
import { Flow, FlowRunState, StepRunState } from '@ai-stepflow/core/types';
import { Icon, metaValue } from '../components/primitives';
import { formatRunTime, getStepSkills } from '../flowUtils';
import { sendToVSCode } from '../vscode';

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
  activeProgress,
  commandCopied,
  onSetActiveStep,
  onRunStep,
  onOpenFile,
  onCopyCommand,
  outputEndRef
}) => {
  const activeStep = flow.steps.find(step => step.id === activeStepId);
  const activeStepState = activeStepId ? runState.steps[activeStepId] : null;
  const stepCosts = flow.steps.map(step => {
    const isHeadless = !!step.review?.required && (step.review.type === 'ai' || !!step.review.reviewers?.some(r => r.type === 'ai'));
    return {
      step,
      state: runState.steps[step.id],
      costUsd: runState.steps[step.id]?.costUsd ?? 0,
      tokensUsed: runState.steps[step.id]?.tokensUsed ?? 0,
      isHeadless
    };
  });
  const totalCostUsd = stepCosts.reduce((sum, item) => sum + item.costUsd, 0);
  const totalTokens = stepCosts.reduce((sum, item) => sum + item.tokensUsed, 0);
  const isLocked = activeStepState?.executionStatus === 'locked';
  const reviewStatus = activeStepState?.reviewStatus;
  const reviewRequired = !!activeStep?.review.required;
  const aiReviewing = reviewStatus === 'ai_review_running';
  // AI-reviewed steps run headless (a tracked `claude` child), so their in-flight run can be
  // cancelled; interactive steps (no-review or human-review) run in the terminal.
  const isHeadless = !!activeStep?.review?.required && (activeStep?.review.type === 'ai' || !!activeStep?.review.reviewers?.some(r => r.type === 'ai'));

  // Primary action button logic — show "Run Step" ONLY for the initial run when ready.
  // Subsequent runs (after failure, rejection, or completion) are handled by "Re-run".
  const canRunStep = !!activeStepState && activeStepState.executionStatus === 'ready' && (activeStepState.history?.length ?? 0) === 0;

  // Review actions: show while terminal is running (interactive) OR after terminal ends waiting human
  const isInteractiveRunning = !isHeadless && activeStepState?.executionStatus === 'running';
  const showReviewButtons = isInteractiveRunning ||
    (activeStepState?.executionStatus === 'completed' && reviewRequired && reviewStatus === 'waiting_human');

  // Finish shows after human approval when the step needs an explicit "done" click to advance.
  const showFinish = activeStepState?.completionStatus === 'ready_to_mark_done';

  // Re-run shows for any non-running terminal outcome: failed, cancelled, rejected, or done.
  const canRerun = !!activeStepState && !isLocked && activeStepState.executionStatus !== 'running' && (activeStepState.history?.length ?? 0) > 0;

  // A step's true state spans three axes (execution / review / completion); the badge collapses
  // them into one label, mirroring aidlc's StatusBadge. Order matters — the most final/specific
  // state wins (done > failed/rejected > running > review gate > ready/locked).
  const stepStatusBadge = (state: StepRunState | null | undefined) => {
    if (!state) return null;
    const { executionStatus, reviewStatus, completionStatus } = state;
    if (completionStatus === 'done') return <span className="badge success"><Icon.Check size={10} style={{ marginRight: 4 }} />done</span>;
    if (executionStatus === 'failed') return <span className="badge error"><Icon.X size={10} style={{ marginRight: 4 }} />failed</span>;
    if (reviewStatus === 'rejected') return <span className="badge error"><Icon.X size={10} style={{ marginRight: 4 }} />rejected</span>;
    if (reviewStatus === 'approved' || completionStatus === 'ready_to_mark_done') return <span className="badge success"><Icon.Check size={10} style={{ marginRight: 4 }} />approved</span>;
    if (executionStatus === 'running') return <span className="badge progress"><Icon.Play size={10} style={{ marginRight: 4 }} />running</span>;
    if (reviewStatus === 'ai_review_running') return <span className="badge progress"><Icon.RotateCw size={10} style={{ marginRight: 4 }} className="spin" />reviewing</span>;
    if (reviewStatus === 'waiting_human' || (reviewRequired && executionStatus === 'completed')) return <span className="badge warning"><Icon.Info size={10} style={{ marginRight: 4 }} />waiting review</span>;
    if (executionStatus === 'completed') return <span className="badge progress">completed</span>;
    if (executionStatus === 'cancelled') return <span className="badge">cancelled</span>;
    if (executionStatus === 'locked') return <span className="badge"><Icon.Lock size={10} style={{ marginRight: 4 }} />locked</span>;
    if (executionStatus === 'ready') return <span className="badge">ready</span>;
    return null;
  };

  const flowHistory = (auditLogs[flow.id] || [])
    .filter(event => event.stepId === activeStepId)
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

  // Overall run status (summarized from steps).
  const getRunStatus = () => {
    const statuses = Object.values(runState.steps).map(s => s.executionStatus);
    const completionStatuses = Object.values(runState.steps).map(s => s.completionStatus);
    if (completionStatuses.every(s => s === 'done')) return { label: 'Done', className: 'success', Icon: Icon.Check };
    if (statuses.includes('failed')) return { label: 'Failed', className: 'error', Icon: Icon.X };
    if (statuses.includes('running')) return { label: 'Running', className: 'progress', Icon: Icon.Play };
    if (statuses.includes('cancelled')) return { label: 'Cancelled', className: '', Icon: Icon.Info };
    return { label: 'Ready', className: '', Icon: Icon.Info };
  };

  const runStatus = getRunStatus();
  // Reset is available once any step has moved past its initial ready/locked state.
  const canResetRun = Object.values(runState.steps).some(
    s => s.executionStatus !== 'ready' && s.executionStatus !== 'locked'
  );

  return (
    <div className="runner">
      <div className="runner-head">
        <div className="runner-head-info">
          <div className="flex-row items-center gap-8 mb-4">
            <span className="runner-flow-name">{flow.name}</span>
            <span className={`badge ${runStatus.className}`}>
              <runStatus.Icon size={10} style={{ marginRight: 4 }} />
              {runStatus.label}
            </span>
          </div>
          <span className="small muted">
            {completedSteps}/{flow.steps.length} steps done · {formatRunTime(runState.runId)}
          </span>
        </div>
        <div className="runner-head-actions">
          {canResetRun && (
            <button className="btn" title="Reset all steps to initial state" onClick={() => sendToVSCode('resetRun', {})}>Reset</button>
          )}
          <button className="btn" onClick={() => sendToVSCode('verifyRun', {})}>Verify</button>
          <button className="btn" onClick={() => sendToVSCode('exportRunReport', {})}>Report</button>
        </div>
      </div>
      <div className="runner-strip">
        {flow.steps.map((step, index) => {
          const stepState = runState.steps[step.id];
          const isActive = activeStepId === step.id;
          const isDone = stepState?.completionStatus === 'done';
          const isStepLocked = stepState?.executionStatus === 'locked';
          return (
            <React.Fragment key={step.id}>
              {index > 0 && <span className="strip-connector" />}
              <button
                type="button"
                className={`strip-step ${isActive ? 'active' : ''} ${isDone ? 'done' : ''} ${isStepLocked ? 'locked' : ''}`}
                title={step.title || step.id}
                onClick={() => onSetActiveStep(step.id)}
              >
                {isDone ? <Icon.Check size={14} /> : index + 1}
              </button>
            </React.Fragment>
          );
        })}
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
            {aiReviewing && (
              <span className="badge progress">
                <Icon.RotateCw size={10} style={{ marginRight: 4 }} className="spin" />
                AI reviewing…
              </span>
            )}

            {canRunStep && (
              <button className="btn primary" title="Run this step" onClick={() => onRunStep(activeStepId!, '')}>
                <span className="btn-glyph"><Icon.Play size={14} /></span>Run Step
              </button>
            )}
            {showReviewButtons && (
              <>
                {activeStep?.review.filePath && (
                  <button className="btn" title={activeStep.review.filePath} onClick={() => onOpenFile(activeStep.review.filePath!)}>Open review file</button>
                )}
                <button className="btn success" title="Approve this step" onClick={() => sendToVSCode('reviewStep', {
                  stepId: activeStepId!,
                  decision: 'approved'
                })}>Approve</button>
                <button className="btn error" title="Reject this step" onClick={() => sendToVSCode('reviewStep', {
                  stepId: activeStepId!,
                  decision: 'rejected'
                })}>Reject</button>
              </>
            )}
            {showFinish && (
              <button className="btn primary" title="Complete this step" onClick={() => sendToVSCode('markStepDone', {
                stepId: activeStepId!,
                historyEvent: { timestamp: new Date().toISOString(), status: 'completed', message: 'Marked done by user' }
              })}>
                <span className="btn-glyph"><Icon.Check size={14} /></span>Finish
              </button>
            )}
            {canRerun && (
              <button className="btn" title="Re-run this step" onClick={() => onRunStep(activeStepId!, '')}>
                <span className="btn-glyph"><Icon.RotateCw size={14} /></span>Re-run
              </button>
            )}
            {isLocked && <button className="btn" disabled title="Complete the steps this one depends on first">Locked</button>}
          </div>
        </div>
        {isHeadless && (
          <div className="warning-banner">
            <Icon.Alert size={13} />
            Runs headless — Claude may create or edit files automatically without confirmation (acceptEdits).
          </div>
        )}
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

        <div className="runner-costs">
          <div className="divider-label">Cost Analysis</div>
          <div className="runner-costs-head">
            <div className="small muted">
              {totalCostUsd > 0
                ? `Total $${totalCostUsd.toFixed(4)} · ${totalTokens.toLocaleString()} tokens`
                : totalTokens > 0
                  ? `Total — · ${totalTokens.toLocaleString()} tokens`
                  : 'Cost data available after AI-review steps complete'}
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
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {stepCosts.map(({ step, state, costUsd, tokensUsed, isHeadless }) => {
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
                    <td>{costUsd > 0 ? `${share.toFixed(1)}%` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Persistent Step History Log (Machine Local), grouped per run. */}
        {historyGroups.length > 0 && (
          <div className="step-history">
            <div className="divider-label mb-4">Execution History</div>
            {historyGroups.map(group => (
              <div key={group.runId} className="history-run-group">
                <div className="history-run-head small">
                  <span className="muted mono">{group.runId === 'unknown' ? 'unknown run' : formatRunTime(group.runId)}</span>
                  {group.runId === runState.runId && <span className="badge running">current run</span>}
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
        )}
      </div>
    </div>
  );
};
