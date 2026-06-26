import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveMaxTurns,
  resolveTimeoutMs,
  buildHeadlessMcpConfig,
  composeInteractiveMessage,
} from '@ai-stepflow/core';

test('resolveMaxTurns: agent override wins when set (including 0 = no limit)', () => {
  assert.equal(resolveMaxTurns(12, 6), 12);
  assert.equal(resolveMaxTurns(0, 6), 0);
});

test('resolveMaxTurns: falls back to the global default when unset or negative', () => {
  assert.equal(resolveMaxTurns(undefined, 6), 6);
  assert.equal(resolveMaxTurns(-1, 6), 6);
});

test('resolveTimeoutMs: positive seconds → ms, non-positive → 0 (no limit)', () => {
  assert.equal(resolveTimeoutMs(600), 600_000);
  assert.equal(resolveTimeoutMs(0), 0);
  assert.equal(resolveTimeoutMs(-5), 0);
});

test('buildHeadlessMcpConfig: empty/undefined allowlist yields no servers', () => {
  assert.equal(buildHeadlessMcpConfig([], { a: {} }), '{"mcpServers":{}}');
  assert.equal(buildHeadlessMcpConfig(undefined, { a: {} }), '{"mcpServers":{}}');
});

test('buildHeadlessMcpConfig: keeps only allowlisted servers that exist in ambient config', () => {
  const ambient = { ast: { command: 'ast' }, other: { command: 'x' } };
  const out = JSON.parse(buildHeadlessMcpConfig(['ast', 'missing'], ambient));
  assert.deepEqual(out, { mcpServers: { ast: { command: 'ast' } } });
});

test('composeInteractiveMessage: primary skill becomes a slash command, bare description otherwise', () => {
  assert.equal(composeInteractiveMessage('review', 'do it', [], []), '/review do it');
  assert.equal(composeInteractiveMessage(undefined, 'do it', [], []), 'do it');
});

test('composeInteractiveMessage: appends mandatory input/output file lists when present', () => {
  const msg = composeInteractiveMessage('impl', 'go', ['in/spec.md'], ['out/a.md', 'out/b.md']);
  assert.match(msg, /^\/impl go/);
  assert.match(msg, /Mandatory input files[^\n]*\n- in\/spec\.md/);
  assert.match(msg, /Mandatory output files[^\n]*\n- out\/a\.md\n- out\/b\.md/);
});

