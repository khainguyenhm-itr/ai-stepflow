import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowSaveCancelledState, FLOW_SAVE_REFUSED } from '../src/hooks/appState/flowSaveOrigin.js';
import type { Flow, FlowStep } from '@claudesteps/core/types';

/**
 * Three different call sites post `saveFlow`, and the host can refuse any of them. The refusal must
 * put the user back where they were — not somewhere they never went. This is the pure decision;
 * the React wiring around it just applies these fields.
 */

const step = (id: string): FlowStep => ({
  id, title: id, agent: 'po', skill: 'prd', review: { required: true, type: 'human' },
} as FlowStep);

const draft: Flow = {
  id: 'f1', name: 'f1', description: '', inputs: {}, sourcePath: '/repo/.claudesteps/flows/f1.yaml',
  steps: [step('a'), step('b')],
} as Flow;

test('a refused builder save reopens the builder on the draft', () => {
  const restored = flowSaveCancelledState({ from: 'builder' }, draft);

  assert.ok(restored);
  assert.equal(restored.editingFlow, draft, 'the edit the user made must not be lost');
  assert.equal(restored.builderError, FLOW_SAVE_REFUSED);
  assert.equal(restored.editingStep, null);
  assert.equal(restored.stepEditFromBoard, false);
  assert.equal(restored.stepError, null);
});

test('a refused step-editor save keeps the user in the step editor', () => {
  const editing = { step: step('b'), index: 1 };

  const restored = flowSaveCancelledState({ from: 'stepEditor', step: editing, stepIsNew: true }, draft);

  assert.ok(restored);
  assert.equal(restored.editingStep, editing, 'the step editor was closed instead of restored');
  assert.equal(restored.stepEditFromBoard, true, 'the editor would reopen as a builder-nested one');
  assert.equal(restored.stepIsNew, true, 'a new step would be restored as an existing one');
  assert.equal(restored.stepError, FLOW_SAVE_REFUSED);
  assert.equal(restored.builderError, null, 'the refusal belongs in the open editor, not the builder');
});

test('a refused board-level removal opens nothing — there was no editor to restore', () => {
  assert.equal(flowSaveCancelledState({ from: 'board' }, draft), null);
});

test('a refusal with no recorded origin opens nothing rather than guessing', () => {
  assert.equal(flowSaveCancelledState(null, draft), null);
});
