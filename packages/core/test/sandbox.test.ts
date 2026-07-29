import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  buildSandboxArgs, resolveSandboxWritePaths, SANDBOXED_DENY_SETTINGS, SANDBOXED_PERMISSION_MODE,
  FlowStep,
} from '@claudesteps/core';

function makeStep(extra: Partial<FlowStep>): FlowStep {
  return { id: 'step-1', title: 'Step 1', agent: 'po', skill: 'prd', review: { required: false }, ...extra };
}

test('buildSandboxArgs forces default permission mode and the deny settings', () => {
  const args = buildSandboxArgs(['docs/a.md'], SANDBOXED_DENY_SETTINGS);
  assert.equal(args[args.indexOf('--permission-mode') + 1], SANDBOXED_PERMISSION_MODE);
  assert.equal(args[args.indexOf('--settings') + 1], SANDBOXED_DENY_SETTINGS);
});

test('buildSandboxArgs allows a write/edit rule per declared path and nothing else', () => {
  const args = buildSandboxArgs(['docs/a.md', 'docs/b.md'], '/tmp/s.json');
  const rules = args.slice(args.indexOf('--allowedTools') + 1);
  assert.deepEqual(rules, [
    'Write(docs/a.md)', 'Edit(docs/a.md)', 'MultiEdit(docs/a.md)',
    'Write(docs/b.md)', 'Edit(docs/b.md)', 'MultiEdit(docs/b.md)',
  ]);
});

test('buildSandboxArgs with no declared paths is fail-closed (no allow-rule at all)', () => {
  const args = buildSandboxArgs([], '/tmp/s.json');
  assert.equal(args.includes('--allowedTools'), false);
  assert.equal(args[args.indexOf('--permission-mode') + 1], SANDBOXED_PERMISSION_MODE);
  assert.equal(args.includes('--settings'), true);
});

test('the deny settings block exec and network, which no ambient allow can re-open', () => {
  const parsed = JSON.parse(SANDBOXED_DENY_SETTINGS) as { permissions: { deny: string[] } };
  for (const tool of ['Bash', 'WebFetch', 'WebSearch']) {
    assert.equal(parsed.permissions.deny.includes(tool), true, `${tool} must be denied`);
  }
});

test('buildSandboxArgs accepts a settings file path as well as inline JSON', () => {
  // The interactive launcher passes a path so the flag survives a shell command line without
  // embedding quoted JSON; the headless runner passes the JSON inline via its argv array.
  const args = buildSandboxArgs([], '/tmp/csf-sandbox-abc.json');
  assert.equal(args[args.indexOf('--settings') + 1], '/tmp/csf-sandbox-abc.json');
});

test('resolveSandboxWritePaths lists a step produces + review artifact, relative to the project', () => {
  const project = path.join(path.sep, 'repo');
  const step = makeStep({ produces: ['docs/plan.md'], review: { required: true, filePath: 'docs/review.md' } });
  const paths = resolveSandboxWritePaths(step, project, {}, 'my flow', 'run-1');
  assert.equal(paths.length, 2);
  for (const p of paths) {
    assert.equal(path.isAbsolute(p), false, `${p} should be project-relative`);
    assert.equal(p.startsWith('..'), false, `${p} should stay inside the project`);
  }
  assert.equal(paths.some(p => p.endsWith('plan.md')), true);
  assert.equal(paths.some(p => p.endsWith('review.md')), true);
});

test('resolveSandboxWritePaths resolves run-input placeholders', () => {
  const project = path.join(path.sep, 'repo');
  const step = makeStep({ produces: ['docs/{ticket}/plan.md'] });
  const paths = resolveSandboxWritePaths(step, project, { ticket: 'EPIC-1' }, 'my flow', 'run-1');
  assert.equal(paths.length, 1);
  assert.equal(paths[0].includes('EPIC-1'), true);
  assert.equal(paths[0].includes('{ticket}'), false);
});

test('resolveSandboxWritePaths returns [] for a step declaring nothing (caller must keep it fail-closed)', () => {
  const paths = resolveSandboxWritePaths(makeStep({}), path.join(path.sep, 'repo'), {}, 'f', 'r');
  assert.deepEqual(paths, []);
});
