import React, { useEffect, useState } from 'react';
import { Flow, FlowRunState, StepRunState } from '@ai-stepflow/core/types';
import { Icon, metaValue } from '../components/primitives';
import { formatRunTime, getStepSkills } from '../flowUtils';
import { sendToVSCode } from '../vscode';

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
    } else if (reviewStatus === 'rejected') {
      // AI review rejected the step and the run halted. A rejection isn't always a hard stop — the
      // human may judge the artifact acceptable — so surface an override gate: Approve to accept it
      // anyway and advance, Reject to keep it rejected, or Re-run to fix and retry.
      actions.showReview = true;
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

  const isFinalized = !!runState.isClosed;

  // A single step can be reset once it has left its pristine initial state (ready/locked with no
  // history) — the escape hatch for a step wedged in a state with no valid action (e.g. no Finish).
  // Cannot reset if currently running.
  const canResetStep = !isFinalized && !!activeStepState && activeStepState.executionStatus !== 'running' && !(
    (activeStepState.executionStatus === 'ready' || activeStepState.executionStatus === 'locked')
    && (activeStepState.history?.length ?? 0) === 0
  );

  // Auto-review is a pre-run policy: lock it the moment any step has started, since a step
  // already running under one policy can't have that policy flipped mid-flight. "Started" = has
  // history, or has left its pristine ready/locked execution state.
  const autoReviewLocked = Object.values(runState.steps).some(
    s => (s.history?.length ?? 0) > 0 || (s.executionStatus !== 'ready' && s.executionStatus !== 'locked')
  );


  // Approve/Reject/Finish can wait on a real Claude call (semantic produces check, AI review)
  // before the extension replies, so spin the clicked button until that step's state actually
  // changes (success) or an error is posted back (failure) — both replace `activeStepState`.
  const [pendingAction, setPendingAction] = useState<'approve' | 'reject' | null>(null);
  useEffect(() => {
    setPendingAction(null);
  }, [activeStepId, activeStepState]);

  // Runner content is split into sub-tabs to cut vertical scrolling: the step detail head
  // (status + actions) stays pinned; Console / Files / Cost / History switch below it.
  const [rtab, setRtab] = useState<'console' | 'files' | 'cost' | 'history'>('console');

  // Files this step reads (requires) and writes (produces) — the artifact md files the run
  // creates. Listed in the Files tab so the user can open/inspect each one.
  const inputFiles = activeStep?.requires ?? [];
  const outputFiles = activeStep?.produces ?? [];
  // Review report written when the step is approved or rejected; absent if no review ran yet.
  const reviewFile = activeStepState?.reviewReportPath;

  // Cost + History render as aligned monospace reports (same look as the console block).
  const costReport = (() => {
    const rows = stepCosts.map(({ step, state, costUsd, tokensUsed, taskMs, reviewMs }, i) => {
      const running = state?.executionStatus === 'running';
      const hasRun = !!state && state.executionStatus !== 'ready' && state.executionStatus !== 'locked';
      const stepMs = taskMs + reviewMs;
      return {
        label: `${i + 1} ${step.title || step.id}`,
        model: state?.modelUsed || (running ? '…' : hasRun ? 'interactive' : '—'),
        tokens: tokensUsed > 0 ? tokensUsed.toLocaleString() : running ? '…' : '—',
        cost: costUsd > 0 ? `$${costUsd.toFixed(4)}` : running ? '…' : '—',
        time: stepMs > 0 ? formatDuration(stepMs) : running ? '…' : '—',
        active: activeStepId === step.id,
      };
    });
    const totalTokStr = totalTokens > 0 ? totalTokens.toLocaleString() : '—';
    const totalCostStr = totalCostUsd > 0 ? `$${totalCostUsd.toFixed(4)}` : '—';
    const totalTimeStr = totalTaskMs + totalReviewMs > 0 ? formatDuration(totalTaskMs + totalReviewMs) : '—';
    const labelW = Math.max(4, ...rows.map(r => r.label.length), 5) + 6;
    const modelW = Math.max(5, ...rows.map(r => r.model.length)) + 6;
    const tokW = Math.max(6, ...rows.map(r => r.tokens.length), totalTokStr.length) + 4;
    const costW = Math.max(4, ...rows.map(r => r.cost.length), totalCostStr.length);
    const timeW = Math.max(4, ...rows.map(r => r.time.length), totalTimeStr.length) + 4;
    const line = (l: string, m: string, t: string, c: string, d: string, tail = '') =>
      l.padEnd(labelW) + m.padEnd(modelW) + t.padStart(tokW) + '    ' + c.padStart(costW) + '    ' + d.padStart(timeW) + tail;
    const out = [line('Step', 'Model', 'Tokens', 'Cost', 'Time'), ''];
    rows.forEach(r => out.push(line(r.label, r.model, r.tokens, r.cost, r.time, r.active ? '   ◀ active' : '')));
    out.push(' '.repeat(labelW + modelW) + '─'.repeat(tokW + 4 + costW + 4 + timeW));
    out.push(line('Total', '', totalTokStr, totalCostStr, totalTimeStr));
    return out.join('\n');
  })();

  // History renders as a color-coded console (like the mockup): muted timestamps,
  // status token tinted by outcome, then the message.
  const statusClass = (status: string) => {
    const s = status.toLowerCase();
    if (/(complete|approv|done|success|finish|ok)/.test(s)) return 'ev-ok';
    if (/(run|start|progress|working)/.test(s)) return 'ev-run';
    if (/(reject|fail|error|stop|abort)/.test(s)) return 'ev-err';
    return 'ev-muted';
  };
  // Infer who made a review decision from the audit message, so an AI/validator approve|reject is
  // visually distinct from a human one in the log. Gated on approve|reject so non-review rows that
  // mention "user"/"reviewing" (e.g. "Terminal closed by user") are never mistaken for reviews.
  const reviewActor = (message: string | undefined): 'ai' | 'human' | null => {
    const m = (message || '').toLowerCase();
    if (!/(approv|reject)/.test(m)) return null;
    if (/by user|human review/.test(m)) return 'human';
    if (/review|validator/.test(m)) return 'ai';
    return null;
  };
  const historyNodes = (() => {
    const nodes: React.ReactNode[] = [];
    historyGroups.forEach((group, gi) => {
      const statusW = Math.max(6, ...group.events.map(e => String(e.status).length));
      nodes.push(
        <span key={`grp-${gi}`} className="ev-muted">
          {(gi > 0 ? '\n' : '') + `── ${group.runId === 'unknown' ? 'unknown run' : formatRunTime(group.runId)} ──\n`}
        </span>
      );
      group.events.forEach((e, ei) => {
        const time = new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const status = String(e.status);
        const actor = reviewActor(e.message);
        nodes.push(
          <React.Fragment key={`ev-${gi}-${ei}`}>
            <span className="ev-time">{time}</span>{'  '}
            <span className={statusClass(status)}>{status.padEnd(statusW)}</span>
            {e.message ? <>{'  '}<span className={actor ? `ev-actor-${actor}` : undefined}>{e.message}</span></> : ''}{'\n'}
          </React.Fragment>
        );
      });
    });
    return nodes;
  })();

  return (
    <div className="runner">
      <div className="runner-striprow">
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
        {!isFinalized && (
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
        )}
      </div>
      <div className="runner-detail">
        <div className="step-card">
          <div className="step-card-head">
            <span className="step-card-title">
              {activeStep ? activeStep.title || activeStep.id : 'No step selected'}
            </span>
            {stepStatusBadge(activeStepState)}
            <div className="runner-detail-actions">
            {!isFinalized && (
              <>
                {stepActions.showWorking && (
                  <button className="btn progress" disabled title="AI is processing...">
                    <span className="btn-glyph"><Icon.RotateCw size={14} className="spin" /></span>AI working
                  </button>
                )}
                {aiReviewing && (
                  <button className="btn review" disabled title="AI is reviewing...">
                    <span className="btn-glyph"><Icon.RotateCw size={14} className="spin" /></span>AI reviewing
                  </button>
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
          <div className="step-meta">
            <div className="mcell"><span className="mk">agent</span>{metaValue(activeStep?.agent, 'no agent assigned', true)}</div>
            <div className="mcell"><span className="mk">model</span>{metaValue(activeStepState?.modelUsed, 'not reported yet', true)}</div>
            <div className="mcell"><span className="mk">skill</span>{metaValue(activeStep ? getStepSkills(activeStep).join(', ') : '', 'no skill assigned', true)}</div>
            <div className="mcell"><span className="mk">tokens</span>{metaValue(activeStepState?.tokensUsed != null ? activeStepState.tokensUsed.toLocaleString() : '', 'not reported yet', true)}</div>
            <div className="mcell"><span className="mk">input</span>{metaValue(Object.entries(runState.inputs || {}).map(([key, value]) => `${key}=${value}`).join(' · '), 'no run inputs')}</div>
            <div className="mcell"><span className="mk">cost</span>{metaValue(activeStepState?.costUsd != null ? `$${activeStepState.costUsd.toFixed(4)}` : '', 'not reported yet', true)}</div>
          </div>
        </div>

        <div className="runner-subtabs">
          <button className={`runner-subtab ${rtab === 'console' ? 'on' : ''}`} onClick={() => setRtab('console')}><Icon.Terminal size={13} /> Console</button>
          <button className={`runner-subtab ${rtab === 'files' ? 'on' : ''}`} onClick={() => setRtab('files')}><Icon.FolderOpen size={13} /> Files</button>
          <button className={`runner-subtab ${rtab === 'cost' ? 'on' : ''}`} onClick={() => setRtab('cost')}><Icon.Zap size={13} /> Cost analysis</button>
          <button className={`runner-subtab ${rtab === 'history' ? 'on' : ''}`} onClick={() => setRtab('history')}><Icon.Info size={13} /> History</button>
        </div>

        {rtab === 'console' && (<>
        <div className="console-wrap">
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
            <Icon.X size={13} /> Rejected by review. Re-run to fix, or approve anyway to override and continue.
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

        {/* Input (requires) / output (produces) artifact files for this step; click to open. */}
        {rtab === 'files' && (
          <div className="files-panel">
            <div className="files-group">
              <div className="divider-label">Inputs</div>
              {inputFiles.length > 0
                ? inputFiles.map(f => (
                    <button key={`in-${f}`} type="button" className="file-row" title={`Open ${f}`} onClick={() => onOpenFile(f)}>
                      <Icon.FolderOpen size={13} /><span className="file-path">{f}</span>
                    </button>
                  ))
                : <div className="run-empty">No input files declared.</div>}
            </div>
            <div className="files-group">
              <div className="divider-label">Outputs</div>
              {outputFiles.length > 0
                ? outputFiles.map(f => (
                    <button key={`out-${f}`} type="button" className="file-row" title={`Open ${f}`} onClick={() => onOpenFile(f)}>
                      <Icon.FolderOpen size={13} /><span className="file-path">{f}</span>
                    </button>
                  ))
                : <div className="run-empty">No output files declared.</div>}
            </div>
            {reviewFile && (
              <div className="files-group">
                <div className="divider-label">Review</div>
                <button type="button" className="file-row" title={`Open ${reviewFile}`} onClick={() => onOpenFile(reviewFile)}>
                  <Icon.FolderOpen size={13} /><span className="file-path">{reviewFile}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step-scoped Execution History, grouped per run — aligned monospace log. */}
        {rtab === 'history' && (historyGroups.length > 0
          ? <pre className="console report">{historyNodes}</pre>
          : <div className="run-empty">No execution history yet.</div>)}

        {rtab === 'cost' && (
          <pre className="console report">{costReport}</pre>
        )}

      </div>
    </div>
  );
};
