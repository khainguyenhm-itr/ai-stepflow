import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveTemplate, validateProduces, validateProducesFiles, verifyProducesContent, validateRequires, FlowStep } from '@ai-stepflow/core';
import type { StepRunner, ClaudeStreamingRunResult } from '@ai-stepflow/core';

/** Stub runner returning a fixed result text; records whether it was called. */
function stubRunner(resultText: string): { fn: StepRunner; get calls(): number } {
  let calls = 0;
  const fn: StepRunner = async () => {
    calls += 1;
    return { success: true, exitCode: 0, resultText } as ClaudeStreamingRunResult;
  };
  return { fn, get calls() { return calls; } };
}

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

test('validateProducesFiles checks existence only — ignores content markers', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-stepflow-produces-files-'));
  try {
    const filePath = path.join(dir, 'docs', 'EPIC-1', 'plan.md');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'no marker here', 'utf8');
    // producesContains would fail validateProduces, but validateProducesFiles only checks the file exists.
    const step = makeStep({ produces: ['docs/{ticket}/plan.md'], producesContains: ['## Summary'] });
    assert.equal(validateProducesFiles(step, dir, { ticket: 'EPIC-1' }).ok, true);
    assert.equal(validateProduces(step, dir, { ticket: 'EPIC-1' }).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyProducesContent: verbatim markers pass for free (no LLM call)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-stepflow-verify-fast-'));
  try {
    const filePath = path.join(dir, 'out', 'plan.md');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '## Summary\nready', 'utf8');
    const step = makeStep({ produces: ['out/plan.md'], producesContains: ['## Summary'] });
    const runner = stubRunner('{"unmet":["should not be used"]}');
    const res = await verifyProducesContent(step, dir, {}, "", runner.fn);
    assert.equal(res.ok, true);
    assert.equal(runner.calls, 0); // fast path, judge never invoked
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyProducesContent: judge approves non-verbatim content semantically', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-stepflow-verify-pass-'));
  try {
    const filePath = path.join(dir, 'out', 'plan.md');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '1. AC-001 ...\n2. AC-002 ...', 'utf8');
    const step = makeStep({ produces: ['out/plan.md'], producesContains: ['numbered AC list'] });
    const runner = stubRunner('{"unmet":[]}');
    const res = await verifyProducesContent(step, dir, {}, "", runner.fn);
    assert.equal(res.ok, true);
    assert.equal(runner.calls, 1); // judge consulted for the non-verbatim marker
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyProducesContent: judge rejects unmet requirements', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-stepflow-verify-fail-'));
  try {
    const filePath = path.join(dir, 'out', 'plan.md');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'some unrelated prose', 'utf8');
    const step = makeStep({ produces: ['out/plan.md'], producesContains: ['numbered AC list'] });
    const runner = stubRunner('{"unmet":["numbered AC list"]}');
    const res = await verifyProducesContent(step, dir, {}, "", runner.fn);
    assert.equal(res.ok, false);
    assert.match(res.message || '', /numbered AC/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyProducesContent: lenient when the judge output is unparseable', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-stepflow-verify-lenient-'));
  try {
    const filePath = path.join(dir, 'out', 'plan.md');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'some prose', 'utf8');
    const step = makeStep({ produces: ['out/plan.md'], producesContains: ['something descriptive'] });
    const runner = stubRunner('not json at all');
    const res = await verifyProducesContent(step, dir, {}, "", runner.fn);
    assert.equal(res.ok, true); // never trap the user on an LLM hiccup
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyProducesContent: no markers is a pass without reading anything', async () => {
  const runner = stubRunner('{"unmet":["x"]}');
  const step = makeStep({ produces: ['plan.md'] });
  const res = await verifyProducesContent(step, "/nonexistent", {}, "", runner.fn);
  assert.equal(res.ok, true);
  assert.equal(runner.calls, 0);
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
