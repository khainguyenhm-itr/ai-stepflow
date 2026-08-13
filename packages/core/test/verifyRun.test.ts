import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Flow, FlowRunState } from '@claudesteps/core';
import { renderVerifyReportMarkdown, verifyRun } from '@claudesteps/core';

function createFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'claudesteps-verify-'));
  const flow: Flow = {
    id: 'flow',
    name: 'Verify Flow',
    description: '',
    inputs: {},
    sourcePath: '/tmp/flow.yaml',
    steps: [{
      id: 'step-1',
      title: 'Write PRD',
      agent: 'po',
      skill: 'prd',
      produces: ['docs/prd.md'],
      producesContains: ['## Summary'],
      review: { required: true, type: 'ai' }
    }]
  };
  const runState: FlowRunState = {
    flowId: 'flow',
    runId: 'run-1',
    source: flow.sourcePath,
    projectPath: dir,
    inputs: {},
    steps: {
      'step-1': {
        executionStatus: 'completed',
        reviewStatus: 'approved',
        completionStatus: 'done'
      }
    }
  };
  return { dir, flow, runState };
}

test('verifyRun passes when produced files still exist and contain markers', () => {
  const { dir, flow, runState } = createFixture();
  try {
    const filePath = path.join(dir, 'docs', 'prd.md');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '## Summary\nShip it', { encoding: 'utf8', flag: 'w' });
    const report = verifyRun(flow, runState, dir);
    assert.equal(report.ok, true);
    assert.equal(report.drift.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyRun reports missing files and markers', () => {
  const { dir, flow, runState } = createFixture();
  try {
    const docsDir = path.join(dir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(path.join(docsDir, 'prd.md'), 'Incomplete', { encoding: 'utf8', flag: 'w' });
    const report = verifyRun(flow, runState, dir);
    assert.equal(report.ok, false);
    assert.equal(report.drift.length, 1);
    assert.deepEqual(report.drift[0].missingMarkers, ['## Summary']);
    assert.match(renderVerifyReportMarkdown(flow, runState, report), /FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyRun never flags a skipped step — it never ran, so its produces were never expected', () => {
  const { dir, flow, runState } = createFixture();
  try {
    // No docs/prd.md written at all — a step that actually ran would drift here.
    runState.steps['step-1'] = { executionStatus: 'skipped', reviewStatus: 'pending', completionStatus: 'done' };
    const report = verifyRun(flow, runState, dir);
    assert.equal(report.ok, true);
    assert.equal(report.checked, 0);
    assert.equal(report.drift.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
