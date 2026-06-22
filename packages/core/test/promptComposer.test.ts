import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeSystemPrompt } from '@ai-stepflow/core';
import type { Agent, Skill } from '@ai-stepflow/core';

const agent: Agent = {
  name: 'dev', description: '', model: 'sonnet', systemPrompt: 'You are a dev.', sourcePath: '/x/dev.md'
};
const skill: Skill = {
  name: 'implement', description: '', instructions: 'Implement the feature.', sourcePath: '/x/implement.md'
};

test('composeSystemPrompt injects Mandatory Input Files from requires', () => {
  const out = composeSystemPrompt(agent, ['implement'], [skill], ['out/notes.md'], {}, ['in/prd.md', 'in/tdd.md']);
  assert.match(out, /## Mandatory Input Files/);
  assert.match(out, /- in\/prd\.md/);
  assert.match(out, /- in\/tdd\.md/);
  assert.match(out, /## Mandatory Output Files/);
  assert.match(out, /- out\/notes\.md/);
});

test('composeSystemPrompt omits the input section when requires is empty or absent', () => {
  assert.doesNotMatch(composeSystemPrompt(agent, [], [], [], {}, []), /Mandatory Input Files/);
  assert.doesNotMatch(composeSystemPrompt(agent, [], []), /Mandatory Input Files/);
});
