import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadStepRunner, resolveStepRunner, defaultStepRunner } from '@ai-stepflow/core';

const opts = { systemPrompt: 'sys', userMessage: 'hi', projectPath: '/tmp', onText: () => {} };

test('resolveStepRunner returns the built-in runner when no path is configured', async () => {
  const runner = await resolveStepRunner(undefined, '/tmp');
  assert.equal(runner, defaultStepRunner);
});

test('loadStepRunner loads a module, streams text and normalizes its result', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-stepflow-runner-'));
  try {
    writeFileSync(
      path.join(dir, 'runner.mjs'),
      "export default async function (opts) { opts.onText('streamed'); return { success: true, resultText: 'ok' }; }",
      'utf8'
    );
    let streamed = '';
    const runner = await loadStepRunner('runner.mjs', dir);
    const result = await runner({ ...opts, onText: chunk => { streamed += chunk; } });
    assert.equal(streamed, 'streamed');
    assert.equal(result.success, true);
    assert.equal(result.resultText, 'ok');
    // exitCode is derived from success when the module omits it.
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadStepRunner throws when the module has no default function', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-stepflow-runner-bad-'));
  try {
    writeFileSync(path.join(dir, 'bad.mjs'), 'export const nope = true;', 'utf8');
    await assert.rejects(loadStepRunner('bad.mjs', dir), /default-export a function/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadStepRunner rejects a malformed runner result at call time', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-stepflow-runner-malformed-'));
  try {
    writeFileSync(path.join(dir, 'runner.mjs'), 'export default async function () { return { nope: 1 }; }', 'utf8');
    const runner = await loadStepRunner('runner.mjs', dir);
    await assert.rejects(runner(opts), /malformed result/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
