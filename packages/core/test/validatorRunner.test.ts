import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runValidator } from '@ai-stepflow/core';
import { FlowRunState, FlowStep } from '@ai-stepflow/core';

function makeStep(reviewPatch: Partial<FlowStep['review']>): FlowStep {
  return {
    id: 'step-1',
    title: 'Step 1',
    agent: 'po',
    skill: 'prd',
    requires: ['docs/{ticket}/brief.md'],
    produces: ['docs/{ticket}/plan.md'],
    review: { required: true, type: 'ai', ...reviewPatch },
    completion: { requireMarkDone: false }
  };
}

function makeRunState(): FlowRunState {
  return {
    flowId: 'flow',
    runId: 'run-1',
    source: '/tmp/flow.yaml',
    projectPath: '/tmp/project',
    inputs: { ticket: 'EPIC-1' },
    steps: {}
  };
}

test('runValidator executes validator module and returns its verdict', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-stepflow-validator-'));
  try {
    const validatorPath = path.join(dir, 'validate.mjs');
    mkdirSync(path.join(dir, 'docs', 'EPIC-1'), { recursive: true });
    writeFileSync(validatorPath, "export default async function (ctx) { return ctx.paths.produces[0].includes('EPIC-1') ? { decision: 'pass', reason: 'ok' } : { decision: 'reject', reason: 'bad' }; }", 'utf8');
    const verdict = await runValidator({
      workspaceRoot: dir,
      step: makeStep({ validatorPath: 'validate.mjs' }),
      runState: makeRunState(),
      stepOutput: 'done'
    });
    assert.deepEqual(verdict, { decision: 'pass', reason: 'ok' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidator rejects malformed or missing validator exports', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-stepflow-validator-bad-'));
  try {
    writeFileSync(path.join(dir, 'bad.mjs'), "export const nope = true;", 'utf8');
    const verdict = await runValidator({
      workspaceRoot: dir,
      step: makeStep({ validatorPath: 'bad.mjs' }),
      runState: makeRunState(),
      stepOutput: 'done'
    });
    assert.equal(verdict.decision, 'reject');
    assert.match(verdict.reason, /default-export/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
