import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTemplate, sanitizeFlowName, shortRunId, runOutputSlug, legacyRunOutputSlug,
  FLOW_NAME_SLUG_MAX
} from '../src/pathTemplates.js';

test('resolveTemplate fills known inputs and leaves unknown/empty ones as-is', () => {
  assert.equal(resolveTemplate('feat-{name}', { name: 'login' }), 'feat-login');
  assert.equal(resolveTemplate('feat-{name}', {}), 'feat-{name}');   // unknown key kept
  assert.equal(resolveTemplate('feat-{name}', { name: '' }), 'feat-{name}'); // empty treated as unset
});

test('sanitizeFlowName slugifies and caps length, never empty', () => {
  assert.equal(sanitizeFlowName('My Cool Flow!'), 'my-cool-flow');
  assert.equal(sanitizeFlowName('   '), 'unnamed');           // reduces to nothing → fallback
  assert.equal(sanitizeFlowName('!!!'), 'unnamed');
  assert.ok(sanitizeFlowName('x'.repeat(200)).length <= FLOW_NAME_SLUG_MAX);
  assert.ok(!sanitizeFlowName('a '.repeat(60)).endsWith('-'));  // no trailing dash after the cap
});

test('shortRunId is deterministic, filesystem-safe, and short', () => {
  const a = shortRunId('2026-07-29T00:00:00.000Z');
  assert.equal(a, shortRunId('2026-07-29T00:00:00.000Z')); // deterministic
  assert.notEqual(a, shortRunId('2026-07-29T00:00:00.001Z'));
  assert.match(a, /^[a-z0-9]{1,7}$/);
  assert.match(shortRunId(undefined), /^[a-z0-9]{1,7}$/);   // no crash on missing id
});

test('runOutputSlug appends the runId fingerprint to a named run (isolation)', () => {
  const a = runOutputSlug('My Run', 'runA');
  const b = runOutputSlug('My Run', 'runB');
  assert.match(a, /^my-run-[a-z0-9]{1,7}$/);
  assert.notEqual(a, b); // same name, different runId → different folder (the isolation guarantee)
});

test('runOutputSlug uses the runId slug for a nameless run, and falls back to run', () => {
  assert.equal(runOutputSlug('', 'run-123'), 'run-123'); // nameless → runId slug, no suffix
  assert.equal(runOutputSlug('', ''), 'run');            // both empty → literal fallback
});

test('legacyRunOutputSlug is the pre-fingerprint slug, or empty when it matches the current slug', () => {
  // Named run: legacy is the bare name; current adds the fingerprint → they differ, legacy is returned.
  assert.equal(legacyRunOutputSlug('My Run', 'runA'), 'my-run');
  // Nameless run: current slug already equals the legacy slug → nothing to fall back to.
  assert.equal(legacyRunOutputSlug('', 'run-123'), '');
});
