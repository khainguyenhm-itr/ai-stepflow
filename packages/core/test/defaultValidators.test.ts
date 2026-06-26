import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runValidator } from '@ai-stepflow/core';
import { FlowRunState, FlowStep } from '@ai-stepflow/core';

// Tests run from the repo root (see package.json test:unit), so resolve the shipped defaults from there.
const DEFAULTS_DIR = path.resolve(process.cwd(), 'packages/extension/resources/defaults');
const VALIDATORS_DIR = path.join(DEFAULTS_DIR, 'validators');

function ctxWith(produces: string[]) {
  return { workspaceRoot: '/tmp', step: {} as FlowStep, runState: {} as FlowRunState, stepOutput: '', paths: { requires: [], produces } };
}

async function loadValidator(name: string) {
  const mod = await import(pathToFileURL(path.join(VALIDATORS_DIR, name)).href);
  return mod.default as (ctx: ReturnType<typeof ctxWith>) => { decision: string; reason: string };
}

test('aisf-produces-complete passes for non-empty files and rejects missing/empty ones', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-pc-'));
  try {
    const ok = path.join(dir, 'a.md');
    const empty = path.join(dir, 'b.md');
    writeFileSync(ok, '# Real Content\n\nThis file has enough meaningful content to pass the minimum byte threshold required by the validator. It clearly contains substantial information.', 'utf8');
    writeFileSync(empty, '', 'utf8');
    const review = await loadValidator('aisf-produces-complete.mjs');
    assert.equal(review(ctxWith([ok])).decision, 'pass');
    assert.equal(review(ctxWith([empty])).decision, 'reject');
    assert.equal(review(ctxWith([path.join(dir, 'missing.md')])).decision, 'reject');
    assert.equal(review(ctxWith([])).decision, 'pass'); // nothing declared → nothing to check
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aisf-no-placeholders rejects leftover TODO/placeholder markers', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-np-'));
  try {
    const clean = path.join(dir, 'clean.md');
    const dirty = path.join(dir, 'dirty.md');
    writeFileSync(clean, 'all done here', 'utf8');
    writeFileSync(dirty, 'intro\nTODO: finish this', 'utf8');
    const review = await loadValidator('aisf-no-placeholders.mjs');
    assert.equal(review(ctxWith([clean])).decision, 'pass');
    assert.equal(review(ctxWith([dirty])).decision, 'reject');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aisf-json-valid rejects malformed JSON only', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-jv-'));
  try {
    const good = path.join(dir, 'good.json');
    const bad = path.join(dir, 'bad.json');
    writeFileSync(good, '{"ok":true}', 'utf8');
    writeFileSync(bad, '{not json', 'utf8');
    const review = await loadValidator('aisf-json-valid.mjs');
    assert.equal(review(ctxWith([good])).decision, 'pass');
    assert.equal(review(ctxWith([bad])).decision, 'reject');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default review kit ships and states the JSON verdict contract', () => {
  const kit = readFileSync(path.join(DEFAULTS_DIR, 'reviews', 'aisf-review-default.md'), 'utf8');
  assert.match(kit, /ai-stepflow built-in/);
  assert.match(kit, /"decision"\s*:\s*"pass"\|"reject"/);
});

test('runValidator honors an explicit validatorPath override', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-override-'));
  try {
    mkdirSync(path.join(dir, 'v'), { recursive: true });
    writeFileSync(path.join(dir, 'v', 'pass.mjs'), "export default () => ({ decision: 'pass', reason: 'override ran' });", 'utf8');
    const step = { id: 's', title: 's', agent: 'a', skill: 's', review: { required: true, type: 'ai' }, completion: { requireMarkDone: false } } as FlowStep;
    const verdict = await runValidator({ workspaceRoot: dir, step, runState: { inputs: {} } as FlowRunState, stepOutput: '', validatorPath: 'v/pass.mjs' });
    assert.deepEqual(verdict, { decision: 'pass', reason: 'override ran' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
