import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRunReport } from '@ai-stepflow/core';
import { Flow, FlowRunState } from '@ai-stepflow/core';

test('renderRunReport includes step table and audit history', () => {
  const flow: Flow = {
    id: 'flow',
    name: 'Report Flow',
    description: '',
    inputs: { epic: { type: 'string', required: true, label: 'Epic' } },
    sourcePath: '/tmp/flow.yaml',
    steps: [{ id: 'step-1', title: 'Plan', agent: 'po', skill: 'prd', review: { required: false }, completion: { requireMarkDone: false } }]
  };
  const runState: FlowRunState = {
    flowId: 'flow',
    runId: '2026-06-05T10:00:00.000Z',
    source: flow.sourcePath,
    projectPath: '/tmp/project',
    inputs: { epic: 'EPIC-1' },
    steps: {
      'step-1': {
        executionStatus: 'completed',
        reviewStatus: 'not_required',
        completionStatus: 'done',
        modelUsed: 'claude-sonnet-4-6',
        tokensUsed: 1234,
        costUsd: 0.42
      }
    }
  };

  const markdown = renderRunReport(flow, runState, [
    { runId: runState.runId, stepId: 'step-1', timestamp: runState.runId, status: 'running', message: 'Started run' },
    { runId: runState.runId, stepId: 'step-1', timestamp: runState.runId, status: 'completed', message: 'Marked done' }
  ]);

  assert.match(markdown, /Run Report: Report Flow/);
  // Step number is in the heading (### 1. Plan), not a table column.
  assert.match(markdown, /### 1\. Plan/);
  assert.match(markdown, /\| completed \| not_required \| done \|/);
  assert.match(markdown, /EPIC-1/);
  assert.match(markdown, /Started run/);
});
