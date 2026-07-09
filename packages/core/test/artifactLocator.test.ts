import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { locateProducedFile } from '@ai-stepflow/core';

// Per-run output base for flow 'F' (slug 'f'), run slug 'r'.
function outDir(root: string): string {
  return path.join(root, '.ai-stepflow', 'output', 'f', 'r');
}

test('locateProducedFile returns the exact resolved path when it exists', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-locate-'));
  try {
    const exact = path.join(outDir(dir), 'srs.md');
    mkdirSync(path.dirname(exact), { recursive: true });
    writeFileSync(exact, 'body', 'utf8');
    assert.equal(locateProducedFile('srs.md', 'F', dir, 'r'), exact);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('locateProducedFile finds a plain-named artifact the agent nested in a subfolder', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-locate-'));
  try {
    const nested = path.join(outDir(dir), 'artifact', 'srs.md');
    mkdirSync(path.dirname(nested), { recursive: true });
    writeFileSync(nested, 'body', 'utf8');
    // Declared as plain 'srs.md' → exact path missing → falls back to the nested file.
    assert.equal(locateProducedFile('srs.md', 'F', dir, 'r'), nested);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('locateProducedFile returns the newest match when several nested copies exist', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-locate-'));
  try {
    const older = path.join(outDir(dir), 'a', 'srs.md');
    const newer = path.join(outDir(dir), 'b', 'srs.md');
    mkdirSync(path.dirname(older), { recursive: true });
    mkdirSync(path.dirname(newer), { recursive: true });
    writeFileSync(older, 'old', 'utf8');
    writeFileSync(newer, 'new', 'utf8');
    const old = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(older, old, old);
    assert.equal(locateProducedFile('srs.md', 'F', dir, 'r'), newer);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('locateProducedFile returns the exact path (unchanged) when no match is found', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-locate-'));
  try {
    const exact = path.join(outDir(dir), 'nope.md');
    assert.equal(locateProducedFile('nope.md', 'F', dir, 'r'), exact);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('locateProducedFile never fuzzy-matches an explicit (slash) path', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aisf-locate-'));
  try {
    // A same-named file exists under the run dir, but the declared path is explicit → literal.
    const nested = path.join(outDir(dir), 'artifact', 'srs.md');
    mkdirSync(path.dirname(nested), { recursive: true });
    writeFileSync(nested, 'body', 'utf8');
    assert.equal(locateProducedFile('docs/srs.md', 'F', dir, 'r'), path.join(dir, 'docs', 'srs.md'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
