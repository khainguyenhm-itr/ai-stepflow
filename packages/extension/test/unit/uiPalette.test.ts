import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { SIDEBAR_PALETTE, renderPaletteVars } from '../../src/uiPalette.js';

/**
 * The sidebar (plain HTML in the extension host) and the cockpit (React, styled by App.css) pin the
 * same palette in two places because the sidebar cannot import the stylesheet. They used to be kept
 * in sync by hand and by comment. This test is the mechanism that makes drift fail the build.
 */

// `__dirname` works here because the extension package compiles to CommonJS (it is bundled by
// esbuild for the extension host). Resolves to packages/extension/out-unit/test/unit.
const APP_CSS = path.resolve(__dirname, '../../../../webview/src/App.css');

/** Parse the `:root { --x: value; }` block of App.css into a map. */
function readAppCssRootVars(): Map<string, string> {
  const css = readFileSync(APP_CSS, 'utf8');
  const root = /:root\s*\{([\s\S]*?)\}/.exec(css);
  assert.ok(root, `no :root block found in ${APP_CSS}`);
  const vars = new Map<string, string>();
  for (const line of root[1].split('\n')) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line);
    if (m) vars.set(m[1], m[2].trim());
  }
  return vars;
}

test('App.css still exposes a parseable :root block (the drift guard depends on it)', () => {
  const vars = readAppCssRootVars();
  assert.ok(vars.size > 10, `expected a populated palette, parsed ${vars.size} variables`);
});

test('every sidebar palette value matches its cockpit counterpart in App.css', () => {
  const vars = readAppCssRootVars();
  const mismatched: string[] = [];
  for (const entry of SIDEBAR_PALETTE) {
    const appVar = entry.appCssVar ?? entry.name;
    const expected = vars.get(appVar);
    if (expected === undefined) {
      mismatched.push(`${entry.name}: App.css has no ${appVar}`);
    } else if (expected.toLowerCase() !== entry.value.toLowerCase()) {
      mismatched.push(`${entry.name} (${appVar}): sidebar ${entry.value} vs App.css ${expected}`);
    }
  }
  assert.deepEqual(mismatched, [], `sidebar palette drifted from App.css:\n${mismatched.join('\n')}`);
});

test('palette entries are unique and look like colors', () => {
  const names = SIDEBAR_PALETTE.map(e => e.name);
  assert.equal(new Set(names).size, names.length, 'duplicate palette entry');
  for (const entry of SIDEBAR_PALETTE) {
    assert.match(entry.value, /^#[0-9a-f]{3,8}$/i, `${entry.name} is not a hex color`);
  }
});

test('renderPaletteVars emits one CSS declaration per entry', () => {
  const lines = renderPaletteVars('').split('\n');
  assert.equal(lines.length, SIDEBAR_PALETTE.length);
  assert.equal(lines[0], `${SIDEBAR_PALETTE[0].name}: ${SIDEBAR_PALETTE[0].value};`);
  for (const line of lines) assert.match(line, /^--[a-z0-9-]+: #[0-9a-f]{3,8};$/i);
});
