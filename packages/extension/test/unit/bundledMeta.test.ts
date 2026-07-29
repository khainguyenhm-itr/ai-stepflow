import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstHeading, firstJsComment } from '../../src/bundledMeta.js';

test('firstHeading returns the first markdown heading text', () => {
  assert.equal(firstHeading('# Title\n\nbody'), 'Title');
  assert.equal(firstHeading('## Sub only\n'), 'Sub only');
  assert.equal(firstHeading('body first\n\n# Later'), 'Later');
  assert.equal(firstHeading('no heading here'), '');
  assert.equal(firstHeading('### too deep'), ''); // only # and ## count
});

test('firstJsComment returns the first human comment, skipping claudesteps markers', () => {
  assert.equal(firstJsComment('// hello\ncode();'), 'hello');
  assert.equal(firstJsComment('// claudesteps: managed\n// real description\ncode();'), 'real description');
  assert.equal(firstJsComment('code();'), '');
  assert.equal(firstJsComment('// CLAUDESTEPS marker only'), ''); // case-insensitive skip, nothing left
});
