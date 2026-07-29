import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFlowInputs, normalizeGeneratedSteps } from '../../src/webviewGeneration.js';

test('normalizeFlowInputs coerces junk to a clean inputs record', () => {
  assert.deepEqual(normalizeFlowInputs(undefined), {});
  assert.deepEqual(normalizeFlowInputs('nope'), {});
  assert.deepEqual(normalizeFlowInputs({ '  ': { type: 'string' } }), {}); // blank name dropped
});

test('normalizeFlowInputs fills defaults and trims names', () => {
  assert.deepEqual(normalizeFlowInputs({ ' feature ': {} }), {
    feature: { type: 'string', required: true, label: '' }
  });
  assert.deepEqual(normalizeFlowInputs({ n: { type: 'number', required: false, label: 'Count' } }), {
    n: { type: 'number', required: false, label: 'Count' }
  });
});

test('normalizeGeneratedSteps slugifies ids, de-dupes, and falls back on blanks', () => {
  const out = normalizeGeneratedSteps(
    [{ id: 'My Step!' }, { id: 'My Step!' }, {}],
    new Set(), new Set()
  );
  assert.equal(out[0].id, 'my-step');
  assert.equal(out[1].id, 'my-step-2'); // duplicate disambiguated by index
  assert.equal(out[2].id, 'step-3');    // missing id → positional fallback
});

test('normalizeGeneratedSteps keeps only known agents and skills', () => {
  const out = normalizeGeneratedSteps(
    [{ id: 'a', agent: 'real', skills: ['known', 'ghost'], skill: 'known' }],
    new Set(['real']), new Set(['known'])
  );
  assert.equal(out[0].agent, 'real');
  assert.deepEqual(out[0].skills, ['known']); // 'ghost' dropped
  assert.equal(out[0].skill, 'known');        // primary = first surviving skill
});

test('normalizeGeneratedSteps drops an unknown agent to empty and defaults the review gate', () => {
  const out = normalizeGeneratedSteps([{ id: 'a', agent: 'missing' }], new Set(['real']), new Set());
  assert.equal(out[0].agent, '');
  assert.deepEqual(out[0].review, { required: true, type: 'ai' });
});

test('normalizeGeneratedSteps defaults dependsOn to the previous step', () => {
  const out = normalizeGeneratedSteps([{ id: 'a' }, { id: 'b' }], new Set(), new Set());
  assert.deepEqual(out[0].dependsOn, []);       // first step depends on nothing
  assert.deepEqual(out[1].dependsOn, ['a']);    // second chains off the first
});

test('normalizeGeneratedSteps honors an explicit human review type', () => {
  const out = normalizeGeneratedSteps([{ id: 'a', review: { type: 'human' } }], new Set(), new Set());
  assert.deepEqual(out[0].review, { required: true, type: 'human' });
});
