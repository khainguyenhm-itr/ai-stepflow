import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveTemplate, validateProduces, validateRequires, FlowStep } from '@ai-stepflow/core';

function makeStep(extra: Partial<FlowStep>): FlowStep {
  return {
    id: 'step-1',
    title: 'Step 1',
    agent: 'po',
    skill: 'prd',
    review: { required: false },
    completion: { requireMarkDone: false },
    ...extra
  };
}

test('resolveTemplate replaces run input placeholders', () => {
  assert.equal(resolveTemplate('docs/{ticket}/plan.md', { ticket: 'EPIC-1' }), 'docs/EPIC-1/plan.md');
  assert.equal(resolveTemplate('docs/{missing}/plan.md', {}), 'docs/{missing}/plan.md');
});

test('validateRequires checks placeholder-resolved files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-stepflow-requires-'));
  try {
    const filePath = path.join(dir, 'docs', 'EPIC-1', 'brief.md');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'brief', 'utf8');
    const step = makeStep({ requires: ['docs/{ticket}/brief.md'] });
    assert.equal(validateRequires(step, dir, { ticket: 'EPIC-1' }).ok, true);
    assert.equal(validateRequires(step, dir, { ticket: 'EPIC-2' }).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateProduces checks placeholder-resolved files and markers', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-stepflow-produces-'));
  try {
    const filePath = path.join(dir, 'docs', 'EPIC-1', 'plan.md');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '## Summary\nready', 'utf8');
    const step = makeStep({ produces: ['docs/{ticket}/plan.md'], producesContains: ['## Summary'] });
    assert.equal(validateProduces(step, dir, { ticket: 'EPIC-1' }).ok, true);
    const missingMarker = validateProduces(step, dir, { ticket: 'EPIC-2' });
    assert.equal(missingMarker.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateProduces treats review.filePath as a required produced artifact', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-stepflow-review-file-'));
  try {
    const step = makeStep({ review: { required: true, type: 'ai', filePath: 'docs/{ticket}/review.md' } });
    assert.equal(validateProduces(step, dir, { ticket: 'EPIC-1' }).ok, false);

    const filePath = path.join(dir, 'docs', 'EPIC-1', 'review.md');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'review target', 'utf8');
    assert.equal(validateProduces(step, dir, { ticket: 'EPIC-1' }).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
