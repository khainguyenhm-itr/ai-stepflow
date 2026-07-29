import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPinnedChecksum, astGraphTargets, AST_GRAPH_VERSION } from '../../src/astGraph/binary.js';

/**
 * The download path used to fall back to fetching the expected hash from the same host that served
 * the archive, which verifies nothing. It now fails closed. These tests hold that line at the source
 * — a version bump that forgets a checksum breaks here rather than silently installing an
 * unverified executable on a user's machine.
 */

test('every download target pins a real SHA256', () => {
  const targets = astGraphTargets();
  assert.ok(Object.keys(targets).length > 0, 'no download targets defined');
  for (const [name, spec] of Object.entries(targets)) {
    assert.match(spec.sha256, /^[0-9a-f]{64}$/i, `${name} has no valid pinned checksum`);
    assert.doesNotThrow(() => assertPinnedChecksum(spec), `${name} would be refused at install time`);
  }
});

test('a missing, empty, or malformed checksum is refused rather than fetched from the network', () => {
  for (const sha256 of ['', '   ', 'deadbeef', 'not-a-hash', 'g'.repeat(64), '0'.repeat(63)]) {
    assert.throws(
      () => assertPinnedChecksum({ asset: 'x.tar.xz', sha256 }),
      /refusing to install an unverifiable binary/,
      `accepted checksum ${JSON.stringify(sha256)}`
    );
  }
});

test('the refusal tells the user the supported escape hatch', () => {
  assert.throws(() => assertPinnedChecksum({ asset: 'x.tar.xz', sha256: '' }), /binaryPath/);
});

test('every target names an asset and an executable, and the pinned version is set', () => {
  assert.match(AST_GRAPH_VERSION, /^\d+\.\d+\.\d+$/);
  for (const [name, spec] of Object.entries(astGraphTargets())) {
    assert.ok(spec.asset.length > 0, `${name} has no asset name`);
    assert.ok(spec.exe.length > 0, `${name} has no executable name`);
  }
});
