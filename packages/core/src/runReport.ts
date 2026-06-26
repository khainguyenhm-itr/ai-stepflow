import { Flow, FlowRunState } from './types.js';

export interface RunAuditEvent {
  runId?: string;
  stepId?: string;
  timestamp: string;
  status: string;
  message?: string;
}

function formatDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatCost(costUsd?: number): string {
  return typeof costUsd === 'number' ? `$${costUsd.toFixed(4)}` : '—';
}

function formatTokens(tokens?: number): string {
  return typeof tokens === 'number' ? tokens.toLocaleString() : '—';
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/** Render a markdown summary of the run plus its recorded audit events. */
export function renderRunReport(flow: Flow, runState: FlowRunState, auditEvents: RunAuditEvent[] = []): string {
  const lines: string[] = [];
  const runEvents = auditEvents.filter(event => event.runId === runState.runId);

  const title = runState.runName
    ? `# Run Report: ${flow.name} — ${runState.runName}`
    : `# Run Report: ${flow.name}`;
  lines.push(title);
  lines.push('');
  lines.push(`- **Run ID:** ${runState.runId}`);
  if (runState.runName) lines.push(`- **Run Name:** ${runState.runName}`);
  lines.push(`- **Flow ID:** ${runState.flowId}`);
  lines.push(`- **Source:** ${runState.source}`);
  lines.push(`- **Started:** ${formatDate(runState.runId)}`);

  const totalCost = Object.values(runState.steps).reduce((sum, step) => sum + (step.costUsd ?? 0), 0);
  const totalTokens = Object.values(runState.steps).reduce((sum, step) => sum + (step.tokensUsed ?? 0), 0);
  lines.push(`- **Total cost:** ${formatCost(totalCost > 0 ? totalCost : undefined)}`);
  lines.push(`- **Total tokens:** ${formatTokens(totalTokens > 0 ? totalTokens : undefined)}`);

  const inputs = Object.entries(runState.inputs || {});
  if (inputs.length > 0) {
    lines.push('');
    lines.push('## Inputs');
    lines.push('');
    for (const [key, value] of inputs) {
      lines.push(`- \`${key}\`: ${value}`);
    }
  }

  // Prefer externally-supplied audit events; otherwise fall back to per-step history
  // so headless/CLI reports still show a timeline.
  const eventsForStep = (stepId: string): RunAuditEvent[] => {
    if (runEvents.length > 0) return runEvents.filter(event => event.stepId === stepId);
    return (runState.steps[stepId]?.history ?? []).map(entry => ({ stepId, ...entry }));
  };

  lines.push('');
  lines.push('## Steps');
  lines.push('');

  for (const [index, step] of flow.steps.entries()) {
    const state = runState.steps[step.id];
    lines.push(`### ${index + 1}. ${step.title || step.id}`);
    lines.push('');
    lines.push('| Execution | Review | Completion | Model | Tokens | Cost |');
    lines.push('|-----------|--------|------------|-------|--------|------|');
    lines.push(
      `| ${state?.executionStatus ?? '—'} | ${state?.reviewStatus ?? '—'} | ${state?.completionStatus ?? '—'} | ${escapeCell(state?.modelUsed ?? '—')} | ${formatTokens(state?.tokensUsed)} | ${formatCost(state?.costUsd)} |`
    );

    const events = eventsForStep(step.id);
    if (events.length > 0) {
      lines.push('');
      lines.push('#### Execution History');
      lines.push('');
      for (const event of events) {
        lines.push(`- ${formatDate(event.timestamp)} · **${event.status}**${event.message ? ` · ${event.message}` : ''}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
