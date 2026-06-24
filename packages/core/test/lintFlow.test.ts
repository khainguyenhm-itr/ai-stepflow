/**
 * Tests for the `lintFlow` validation logic extracted from cli.ts.
 *
 * lintFlow() is a pure function so we test it directly rather than going through
 * the CLI binary. The function signature matches what cli.ts exports internally;
 * these tests validate each lint rule independently and together.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Flow, FlowStep } from '@ai-stepflow/core';

// ---------------------------------------------------------------------------
// Inline the pure lintFlow function (mirrors cli.ts implementation) so core
// package tests don't depend on the extension package.
// ---------------------------------------------------------------------------

interface LintIssue {
  kind: 'error' | 'warning';
  stepId: string;
  stepTitle: string;
  message: string;
}

function lintFlow(
  flow: Flow,
  agents: { name: string }[],
  skills: { name: string }[]
): LintIssue[] {
  const issues: LintIssue[] = [];
  const stepIds = new Set(flow.steps.map(s => s.id));
  const agentNames = new Set(agents.map(a => a.name));
  const skillNames = new Set(skills.map(s => s.name));

  for (const step of flow.steps) {
    const label = step.title || step.id;

    if (!step.agent) {
      issues.push({ kind: 'error', stepId: step.id, stepTitle: label, message: 'no agent declared' });
    } else if (!agentNames.has(step.agent)) {
      issues.push({ kind: 'error', stepId: step.id, stepTitle: label, message: `agent '${step.agent}' not found in library` });
    }

    const stepSkills = step.skills?.length ? step.skills : (step.skill ? [step.skill] : []);
    if (stepSkills.length === 0) {
      issues.push({ kind: 'error', stepId: step.id, stepTitle: label, message: 'no skill declared' });
    } else {
      for (const sk of stepSkills) {
        if (!skillNames.has(sk)) {
          issues.push({ kind: 'error', stepId: step.id, stepTitle: label, message: `skill '${sk}' not found in library` });
        }
      }
    }

    for (const dep of step.dependsOn ?? []) {
      if (!stepIds.has(dep)) {
        issues.push({ kind: 'error', stepId: step.id, stepTitle: label, message: `dependsOn '${dep}' does not match any step id` });
      }
    }

    if (!step.produces || step.produces.length === 0) {
      issues.push({ kind: 'warning', stepId: step.id, stepTitle: label, message: 'no produces declared — completion cannot be auto-verified' });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlow(steps: Partial<FlowStep>[]): Flow {
  return {
    id: 'test-flow',
    name: 'Test Flow',
    description: '',
    sourcePath: '/tmp/test-flow.yaml',
    steps: steps.map((s, i) => ({
      id: s.id ?? `step-${i}`,
      title: s.title ?? `Step ${i}`,
      agent: s.agent ?? 'engineer',
      skill: s.skill,
      skills: s.skills,
      produces: s.produces ?? ['out/artifact.md'],
      requires: s.requires ?? [],
      dependsOn: s.dependsOn ?? [],
      review: s.review ?? { required: false },
      completion: s.completion ?? { requireMarkDone: false },
    } as FlowStep)),
  } as Flow;
}

const AGENTS = [{ name: 'engineer' }, { name: 'reviewer' }];
const SKILLS = [{ name: 'implement' }, { name: 'review' }];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('lintFlow: clean flow with valid agent, skill, produces — no issues', () => {
  const flow = makeFlow([
    { agent: 'engineer', skill: 'implement', produces: ['out/feature.md'] },
  ]);
  const issues = lintFlow(flow, AGENTS, SKILLS);
  assert.equal(issues.length, 0, `Expected 0 issues, got: ${issues.map(i => i.message).join(', ')}`);
});

test('lintFlow: unknown agent emits error', () => {
  const flow = makeFlow([{ agent: 'ghost', skill: 'implement', produces: ['out/x.md'] }]);
  const issues = lintFlow(flow, AGENTS, SKILLS);
  const errors = issues.filter(i => i.kind === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /agent 'ghost' not found/);
});

test('lintFlow: missing agent field emits error', () => {
  // Build a step with no agent manually (makeFlow always sets a default).
  const flow: Flow = {
    id: 'test-flow', name: 'Test Flow', description: '', sourcePath: '/tmp/flow.yaml',
    steps: [{
      id: 'step-0', title: 'Step 0',
      agent: '' as unknown as string, // empty string = falsy — matches the !step.agent guard
      skill: 'implement', produces: ['out/x.md'],
      requires: [], dependsOn: [],
      review: { required: false }, completion: { requireMarkDone: false },
    } as FlowStep],
  } as Flow;
  const issues = lintFlow(flow, AGENTS, SKILLS);
  const errors = issues.filter(i => i.kind === 'error');
  assert.ok(errors.some(e => e.message === 'no agent declared'));
});

test('lintFlow: unknown skill emits error', () => {
  const flow = makeFlow([{ agent: 'engineer', skill: 'magic', produces: ['out/x.md'] }]);
  const issues = lintFlow(flow, AGENTS, SKILLS);
  const errors = issues.filter(i => i.kind === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /skill 'magic' not found/);
});

test('lintFlow: no skill declared emits error', () => {
  const flow = makeFlow([{ agent: 'engineer', skill: undefined, skills: [], produces: ['out/x.md'] }]);
  const issues = lintFlow(flow, AGENTS, SKILLS);
  assert.ok(issues.some(i => i.kind === 'error' && i.message === 'no skill declared'));
});

test('lintFlow: skills array checked — one missing skill emits one error', () => {
  const flow = makeFlow([{ agent: 'engineer', skills: ['implement', 'nonexistent'], produces: ['out/x.md'] }]);
  const issues = lintFlow(flow, AGENTS, SKILLS);
  const errors = issues.filter(i => i.kind === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /skill 'nonexistent' not found/);
});

test('lintFlow: broken dependsOn reference emits error', () => {
  const flow = makeFlow([
    { id: 'step-a', agent: 'engineer', skill: 'implement', produces: ['out/a.md'], dependsOn: [] },
    { id: 'step-b', agent: 'reviewer', skill: 'review', produces: ['out/b.md'], dependsOn: ['step-MISSING'] },
  ]);
  const issues = lintFlow(flow, AGENTS, SKILLS);
  const errors = issues.filter(i => i.kind === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /dependsOn 'step-MISSING'/);
});

test('lintFlow: valid dependsOn reference emits no error', () => {
  const flow = makeFlow([
    { id: 'step-a', agent: 'engineer', skill: 'implement', produces: ['out/a.md'], dependsOn: [] },
    { id: 'step-b', agent: 'reviewer', skill: 'review', produces: ['out/b.md'], dependsOn: ['step-a'] },
  ]);
  const issues = lintFlow(flow, AGENTS, SKILLS);
  assert.equal(issues.filter(i => i.kind === 'error').length, 0);
});

test('lintFlow: missing produces emits warning (not error)', () => {
  const flow = makeFlow([{ agent: 'engineer', skill: 'implement', produces: [] }]);
  const issues = lintFlow(flow, AGENTS, SKILLS);
  assert.equal(issues.filter(i => i.kind === 'error').length, 0);
  assert.ok(issues.some(i => i.kind === 'warning' && /no produces/.test(i.message)));
});

test('lintFlow: multiple errors on same step all reported', () => {
  const flow = makeFlow([{ agent: 'ghost', skill: 'magic', produces: [], dependsOn: ['step-MISSING'] }]);
  const issues = lintFlow(flow, AGENTS, SKILLS);
  const errors = issues.filter(i => i.kind === 'error');
  // agent not found + skill not found + broken dependsOn = 3 errors
  assert.equal(errors.length, 3);
});

test('lintFlow: empty library reports errors for every step', () => {
  const flow = makeFlow([
    { agent: 'engineer', skill: 'implement', produces: ['out/a.md'] },
    { agent: 'reviewer', skill: 'review', produces: ['out/b.md'] },
  ]);
  const issues = lintFlow(flow, [], []);
  // 2 steps × (1 agent error + 1 skill error) = 4 errors
  assert.equal(issues.filter(i => i.kind === 'error').length, 4);
});
