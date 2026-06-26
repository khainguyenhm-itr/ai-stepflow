import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeSystemPrompt, composeSystemPromptParts } from '@ai-stepflow/core';
import type { Agent, Skill } from '@ai-stepflow/core';

const agent: Agent = {
  name: 'dev', description: '', model: 'sonnet', systemPrompt: 'You are a dev.', sourcePath: '/x/dev.md'
};
const skill: Skill = {
  name: 'implement', description: '', instructions: 'Implement the feature.', sourcePath: '/x/implement.md'
};

// --- composeSystemPrompt (legacy wrapper) -----------------------------------

test('composeSystemPrompt injects Mandatory Input Files from requires', () => {
  const out = composeSystemPrompt(agent, ['implement'], [skill], ['out/notes.md'], {}, ['in/prd.md', 'in/tdd.md']);
  assert.match(out, /## Mandatory Input Files/);
  assert.match(out, /- in\/prd\.md/);
  assert.match(out, /- in\/tdd\.md/);
  assert.match(out, /## Mandatory Output Files/);
  assert.match(out, /- out\/notes\.md/);
});

test('composeSystemPrompt injects Required Content from producesContains', () => {
  const out = composeSystemPrompt(agent, [], [], ['out/report.md'], {}, [], ['## Summary', 'verdict PASS/FAIL']);
  assert.match(out, /## Required Content/);
  assert.match(out, /- ## Summary/);
  assert.match(out, /- verdict PASS\/FAIL/);
  assert.match(out, /verbatim/);
});

test('composeSystemPrompt omits Required Content when producesContains is empty or absent', () => {
  assert.doesNotMatch(composeSystemPrompt(agent, [], [], ['out.md'], {}, [], []), /Required Content/);
  assert.doesNotMatch(composeSystemPrompt(agent, [], [], ['out.md']), /Required Content/);
});

test('composeSystemPrompt omits the input section when requires is empty or absent', () => {
  assert.doesNotMatch(composeSystemPrompt(agent, [], [], [], {}, []), /Mandatory Input Files/);
  assert.doesNotMatch(composeSystemPrompt(agent, [], []), /Mandatory Input Files/);
});

// --- composeSystemPromptParts (cache-split) ----------------------------------

test('composeSystemPromptParts: static contains agent prompt and skill body', () => {
  const { static: s, dynamic: d } = composeSystemPromptParts(agent, ['implement'], [skill]);
  assert.match(s, /You are a dev/);
  assert.match(s, /Implement the feature/);
  // Dynamic should be empty when no inputs/produces/requires are given
  assert.equal(d.trim(), '');
});

test('composeSystemPromptParts: dynamic contains inputs, produces, requires', () => {
  const { static: s, dynamic: d } = composeSystemPromptParts(
    agent, ['implement'], [skill],
    ['out/notes.md'],
    { feature: 'login' },
    ['in/prd.md']
  );
  // Dynamic has all run-specific context
  assert.match(d, /login/);
  assert.match(d, /out\/notes\.md/);
  assert.match(d, /in\/prd\.md/);
  // Static must NOT contain run-specific context
  assert.doesNotMatch(s, /login/);
  assert.doesNotMatch(s, /out\/notes\.md/);
  assert.doesNotMatch(s, /in\/prd\.md/);
});

test('composeSystemPromptParts: static is stable across different run inputs (cache-friendly)', () => {
  const base = { agent, skillNames: ['implement'] as string[], skills: [skill] };
  const run1 = composeSystemPromptParts(agent, ['implement'], [skill], ['a.md'], { epic: 'A' }, []);
  const run2 = composeSystemPromptParts(agent, ['implement'], [skill], ['b.md'], { epic: 'B' }, ['x.md']);
  // Static (agent + skills) is identical regardless of run-specific context
  assert.equal(run1.static, run2.static);
  // Dynamic differs
  assert.notEqual(run1.dynamic, run2.dynamic);
  void base;
});

test('composeSystemPromptParts: backward-compat — joined parts equal composeSystemPrompt output', () => {
  const produces = ['out/report.md'];
  const inputs = { ticket: 'JIRA-1' };
  const requires = ['spec.md'];
  const { static: s, dynamic: d } = composeSystemPromptParts(agent, ['implement'], [skill], produces, inputs, requires);
  const joined = [s, d].filter(Boolean).join('\n\n');
  const legacy = composeSystemPrompt(agent, ['implement'], [skill], produces, inputs, requires);
  assert.equal(joined, legacy);
});

test('composeSystemPromptParts: no agent system prompt leaves static as skills-only', () => {
  const agentNoPrompt: Agent = { ...agent, systemPrompt: '' };
  const { static: s } = composeSystemPromptParts(agentNoPrompt, ['implement'], [skill]);
  assert.doesNotMatch(s, /You are a dev/);
  assert.match(s, /Implement the feature/);
});

test('composeSystemPromptParts: unknown skill name is silently skipped', () => {
  const { static: s } = composeSystemPromptParts(agent, ['nonexistent'], [skill]);
  // Agent prompt still present
  assert.match(s, /You are a dev/);
  // Unknown skill not injected
  assert.doesNotMatch(s, /Implement the feature/);
});
