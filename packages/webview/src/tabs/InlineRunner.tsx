import React from 'react';
import { Flow, FlowRunState, StepRunState } from '@ai-stepflow/core/types';
import { Icon, ProgressBar, metaValue } from '../components/primitives';
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
  const stepCosts = flow.steps.map(step => ({
    step,
    state: runState.steps[step.id],
    costUsd: runState.steps[step.id]?.costUsd ?? 0,
    tokensUsed: runState.steps[step.id]?.tokensUsed ?? 0
  }));
  const totalCostUsd = stepCosts.reduce((sum, item) => sum + item.costUsd, 0);
  const totalTokens = stepCosts.reduce((sum, item) => sum + item.tokensUsed, 0);
  const stepHasStarted = activeStepState?.executionStatus === 'running' || activeStepState?.executionStatus === 'completed';
  const isLocked = activeStepState?.executionStatus === 'locked';
  const canRunStep = !!activeStepState
    && !isLocked
    && activeStepState.executionStatus !== 'running'
    && activeStepState.completionStatus !== 'done';
  const isRerun = activeStepState?.executionStatus === 'completed' || activeStepState?.executionStatus === 'failed' || activeStepState?.executionStatus === 'cancelled';
  const reviewStatus = activeStepState?.reviewStatus;
  const reviewRequired = !!activeStep?.review.required;
  const aiReviewing = reviewStatus === 'ai_review_running';
  // AI-reviewed steps run headless (a tracked `claude` child), so their in-flight run can be
  // cancelled; interactive steps run in the terminal and have no child to kill.
  const isHeadless = reviewRequired && (activeStep?.review.type === 'ai' || !!activeStep?.review.reviewers?.some(r => r.type === 'ai'));
  const canCancel = isHeadless && activeStepState?.executionStatus === 'running';
  // In the interactive-terminal model the human watches the run and decides, so
  // any review-required step shows Approve/Reject until a decision is recorded.
  const reviewDecided = reviewStatus === 'approved' || reviewStatus === 'rejected';
  const showHumanReviewButtons = stepHasStarted && reviewRequired && !reviewDecided;
  // Mark done finishes the step (and triggers the silent token capture). It is the
  // completion action for non-review steps once their terminal run has started, and
  // the post-approval action for review steps.
  const needsManualDone = activeStepState?.completionStatus !== 'done'
    && (reviewStatus === 'approved' || (!reviewRequired && stepHasStarted));

  // A step's true state spans three axes (execution / review / completion); the badge collapses
  // them into one label, mirroring aidlc's StatusBadge. Order matters — the most final/specific
  // state wins (done > failed/rejected > running > review gate > ready/locked).
  const stepStatusBadge = (state: StepRunState | null | undefined) => {
    if (!state) return null;
    const { executionStatus, reviewStatus, completionStatus } = state;
    if (completionStatus === 'done') return <span className="badge success">done</span>;
    if (executionStatus === 'failed') return <span className="badge error">failed</span>;
    if (reviewStatus === 'rejected') return <span className="badge error">rejected</span>;
    if (executionStatus === 'running') return <span className="badge running">running</span>;
    if (reviewStatus === 'ai_review_running') return <span className="badge running">reviewing</span>;
    if (reviewStatus === 'approved' || completionStatus === 'ready_to_mark_done') return <span className="badge success">approved</span>;
    if (reviewStatus === 'waiting_human' || (reviewRequired && executionStatus === 'completed')) return <span className="badge warn">awaiting review</span>;
    if (executionStatus === 'completed') return <span className="badge success">completed</span>;
    if (executionStatus === 'cancelled') return <span className="badge">cancelled</span>;
    if (executionStatus === 'locked') return <span className="badge">locked</span>;
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

  return (
    <div className="runner">
      <div className="runner-head">
        <div className="runner-head-info">
          <span className="small">
            {flow.name} · {completedSteps}/{flow.steps.length} steps done · <span className="muted">{formatRunTime(runState.runId)}</span>
          </span>
        </div>
        <div className="runner-head-actions">
          <button className="btn" onClick={() => sendToVSCode('verifyRun', {})}>Verify</button>
          <button className="btn" onClick={() => sendToVSCode('exportRunReport', {})}>Report</button>
          <ProgressBar percent={activeProgress} />
          <span className="small muted">{activeProgress}%</span>
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
            <span className="muted small">STEP {activeStep ? flow.steps.findIndex(step => step.id === activeStep.id) + 1 : '-'}/{flow.steps.length}</span>
            <strong>{activeStep ? activeStep.title || activeStep.id : 'No step selected'}</strong>
            {stepStatusBadge(activeStepState)}
          </div>
          <div className="runner-detail-actions">
            {aiReviewing && <span className="small muted">AI reviewing…</span>}

            {canCancel && (
              <button className="btn danger" title="Stop this headless run" onClick={() => sendToVSCode('cancelStep', { stepId: activeStepId! })}>Cancel</button>
            )}

            {showHumanReviewButtons && (
              <>
                {activeStep?.review.filePath && (
                  <button className="btn" title={activeStep.review.filePath} onClick={() => onOpenFile(activeStep.review.filePath!)}>Open review file</button>
                )}
                <button className="btn" onClick={() => sendToVSCode('submitHumanReview', { 
                  stepId: activeStepId!, 
                  review: { decision: 'approved' },
                  historyEvent: { timestamp: new Date().toISOString(), status: 'approved', message: 'User approved manually' }
                })}>Approve</button>
                <button className="btn danger" onClick={() => sendToVSCode('submitHumanReview', { 
                  stepId: activeStepId!, 
                  review: { decision: 'rejected' },
                  historyEvent: { timestamp: new Date().toISOString(), status: 'rejected', message: 'User rejected manually' }
                })}>Reject</button>
              </>
            )}
            {needsManualDone && (
              <button className="btn primary" title="Complete this step" onClick={() => sendToVSCode('markStepDone', { 
                stepId: activeStepId!,
                historyEvent: { timestamp: new Date().toISOString(), status: 'completed', message: 'Marked done by user' }
              })}>
                <span className="btn-glyph"><Icon.Check size={14} /></span>Mark done
              </button>
            )}
            {/* While a review decision is pending, the slot belongs to Approve/Reject;
                Re-run only appears once the user has approved or rejected. */}
            {canRunStep && !showHumanReviewButtons && <button className="btn primary" onClick={() => onRunStep(activeStepId!, '')}><span className="btn-glyph"><Icon.Play size={14} /></span>{isRerun ? 'Re-run' : 'Run step'}</button>}
            {isLocked && <button className="btn" disabled title="Complete the steps this one depends on first">Locked</button>}
          </div>
        </div>
        {isHeadless && (
          <div className="small muted" title="Headless AI-reviewed steps run with --permission-mode acceptEdits">
            ⚠ Runs headless — Claude may create or edit files automatically without confirmation (acceptEdits).
          </div>
        )}
        <div className="runner-meta">
          <div className="meta-group">
            <span className="muted small">agent</span>
            {metaValue(activeStep?.agent, 'no agent assigned', true)}
            <span className="muted small">skill</span>
            {metaValue(activeStep ? getStepSkills(activeStep).join(', ') : '', 'no skill assigned', true)}
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
          <div className="meta-group">
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
        </div>
        <pre className="console">
          {activeStepState?.output || (activeStep ? 'Waiting for run command...' : 'No active step selected.')}
          <div ref={outputEndRef} />
        </pre>

        <div className="runner-costs">
          <div className="runner-costs-head">
            <div className="muted small">Cost Analysis</div>
            <div className="small muted">
              Total {totalCostUsd > 0 ? `$${totalCostUsd.toFixed(4)}` : '$0.0000'} · {totalTokens.toLocaleString()} tokens
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
              {stepCosts.map(({ step, state, costUsd, tokensUsed }) => {
                const share = totalCostUsd > 0 ? (costUsd / totalCostUsd) * 100 : 0;
                return (
                  <tr key={step.id} className={activeStepId === step.id ? 'active' : ''}>
                    <td>{step.title || step.id}</td>
                    <td>{state?.executionStatus || 'ready'}</td>
                    <td>{state?.modelUsed || '—'}</td>
                    <td>{tokensUsed > 0 ? tokensUsed.toLocaleString() : '—'}</td>
                    <td>{costUsd > 0 ? `$${costUsd.toFixed(4)}` : '—'}</td>
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
            <div className="muted small mb-1">Execution History (Local Machine):</div>
            {historyGroups.map(group => (
              <div key={group.runId} className="history-run-group">
                <div className="history-run-head small">
                  <span className="muted mono">{group.runId === 'unknown' ? 'unknown run' : formatRunTime(group.runId)}</span>
                  {group.runId === runState.runId && <span className="badge running">current run</span>}
                </div>
                <div className="history-list">
                  {group.events.map((event, i) => (
                    <div key={i} className="history-item small">
                      <span className="muted mono">{new Date(event.timestamp).toLocaleTimeString()}</span>
                      <span className={`badge ${event.status === 'completed' || event.status === 'approved' ? 'success' : event.status === 'rejected' ? 'error' : event.status === 'running' ? 'running' : ''}`}>
                        {event.status === 'completed' ? 'done' : event.status}
                      </span>
                      <span className="history-message">{event.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {activeStepState?.aiReviewOutput && (
          <>
            <div className="muted small">AI review</div>
            <pre className="console ai-review">{activeStepState.aiReviewOutput}</pre>
          </>
        )}
        {reviewStatus === 'approved' && (
          <div className="small success-text"><Icon.Check size={14} /> Approved</div>
        )}
        {reviewStatus === 'rejected' && (
          <div className="small error-text"><Icon.X size={14} /> Rejected — re-run the step</div>
        )}
      </div>
    </div>
  );
};
