import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByTag, parseTagsInput, UNTAGGED } from '../src/tagUtils.js';

test('groupByTag sorts named groups alphabetically and keeps Untagged last', () => {
  const groups = groupByTag([
    { name: 'c', tags: ['review'] },
    { name: 'a', tags: ['build'] },
    { name: 'b' },
  ]);
  assert.deepEqual(groups.map(g => g.tag), ['build', 'review', UNTAGGED]);
});

test('an item with several tags appears in each of its groups', () => {
  const item = { name: 'a', tags: ['build', 'review'] };
  const groups = groupByTag([item]);
  assert.deepEqual(groups.map(g => g.tag), ['build', 'review']);
  for (const group of groups) assert.deepEqual(group.items, [item]);
});

test('an empty tags array is treated as untagged, not as a group named ""', () => {
  const groups = groupByTag([{ name: 'a', tags: [] }]);
  assert.deepEqual(groups.map(g => g.tag), [UNTAGGED]);
});

test('groupByTag preserves input order inside a group and returns nothing for no items', () => {
  const groups = groupByTag([
    { name: 'first', tags: ['t'] },
    { name: 'second', tags: ['t'] },
  ]);
  assert.deepEqual(groups[0].items.map(i => i.name), ['first', 'second']);
  assert.deepEqual(groupByTag([]), []);
});

test('parseTagsInput splits on commas and newlines, trims, and de-duplicates', () => {
  assert.deepEqual(parseTagsInput('build, review\nbuild'), ['build', 'review']);
  assert.deepEqual(parseTagsInput('  spaced  ,  out  '), ['spaced', 'out']);
});

test('parseTagsInput drops empty entries instead of emitting blank tags', () => {
  assert.deepEqual(parseTagsInput(''), []);
  assert.deepEqual(parseTagsInput(',,\n\n'), []);
  assert.deepEqual(parseTagsInput('a,,b'), ['a', 'b']);
});
