import * as fs from 'fs';
import * as path from 'path';
import { resolveTemplates, resolveFlowPath } from './pathTemplates.js';
import { Flow, FlowRunState } from './types.js';

export interface StepDrift {
  stepId: string;
  title: string;
  executionStatus: string;
  completionStatus: string;
  missingFiles: string[];
  missingMarkers: string[];
}

export interface VerifyReport {
  ok: boolean;
  checked: number;
  drift: StepDrift[];
}

/** Re-check produced artifacts for completed steps against the current filesystem. */
export function verifyRun(flow: Flow, runState: FlowRunState, projectPath: string): VerifyReport {
  const drift: StepDrift[] = [];
  let checked = 0;

  for (const step of flow.steps) {
    const state = runState.steps[step.id];
    if (!state) continue;
    if (state.completionStatus !== 'done' && state.executionStatus !== 'completed') continue;

    const produces = resolveTemplates(step.produces, runState.inputs);
    const markers = step.producesContains ?? [];
    if (produces.length === 0 && markers.length === 0) continue;
    checked++;

    const resolved = produces.map(filePath => resolveFlowPath(filePath, flow.name, projectPath));
    const missingFiles = resolved
      .filter(filePath => !fs.existsSync(filePath))
      .map(filePath => path.relative(projectPath, filePath) || filePath);

    let combinedContents = '';
    for (const filePath of resolved) {
      try {
        combinedContents += fs.readFileSync(filePath, 'utf8');
      } catch {
        // Missing/unreadable files are already represented in missingFiles.
      }
    }
    const missingMarkers = markers.filter(marker => !combinedContents.includes(marker));

    if (missingFiles.length > 0 || missingMarkers.length > 0) {
      drift.push({
        stepId: step.id,
        title: step.title || step.id,
        executionStatus: state.executionStatus,
        completionStatus: state.completionStatus,
        missingFiles,
        missingMarkers
      });
    }
  }

  return { ok: drift.length === 0, checked, drift };
}

export function renderVerifyReportMarkdown(flow: Flow, runState: FlowRunState, report: VerifyReport): string {
  const lines: string[] = [];
  lines.push(`# Verify Report: ${flow.name}`);
  lines.push('');
  lines.push(`- **Run ID:** ${runState.runId}`);
  lines.push(`- **Flow ID:** ${runState.flowId}`);
  lines.push(`- **Checked steps:** ${report.checked}`);
  lines.push(`- **Result:** ${report.ok ? 'PASS' : 'FAIL'}`);
  lines.push('');

  if (report.ok) {
    lines.push('All checked artifacts still exist and still contain the required markers.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Drift');
  lines.push('');
  for (const step of report.drift) {
    lines.push(`### ${step.title}`);
    lines.push(`- **Step ID:** ${step.stepId}`);
    lines.push(`- **Execution:** ${step.executionStatus}`);
    lines.push(`- **Completion:** ${step.completionStatus}`);
    if (step.missingFiles.length > 0) {
      lines.push(`- **Missing files:** ${step.missingFiles.join(', ')}`);
    }
    if (step.missingMarkers.length > 0) {
      lines.push(`- **Missing markers:** ${step.missingMarkers.join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
