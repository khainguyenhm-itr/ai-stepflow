import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSidebarHtml } from '../../src/sidebarHtml.js';

/**
 * The sidebar is a webview: its security rests on a strict Content-Security-Policy and a per-render
 * nonce that is the ONLY thing allowed to run script. These invariants are easy to break silently
 * while editing 1000+ lines of markup, so this test locks them. It is not a full-HTML snapshot
 * (brittle) — it pins only the properties that must never regress.
 */
const stubWebview = (): any => ({ cspSource: 'vscode-webview://unit-test' });

test('sidebar html sets a strict CSP that denies everything by default', () => {
  const html = getSidebarHtml(stubWebview(), { fsPath: '/ext' } as any, '9.9.9');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /style-src vscode-webview:\/\/unit-test 'unsafe-inline'/);
});

test('script is gated by a nonce, and that nonce is what the CSP authorizes', () => {
  const html = getSidebarHtml(stubWebview(), { fsPath: '/ext' } as any, '9.9.9');
  const scriptNonce = html.match(/<script nonce="([^"]+)">/);
  const cspNonce = html.match(/script-src 'nonce-([^']+)'/);
  assert.ok(scriptNonce, 'the client script must carry a nonce attribute');
  assert.ok(cspNonce, 'the CSP must authorize a script nonce');
  assert.equal(scriptNonce![1], cspNonce![1]); // the tag's nonce is exactly the one the CSP allows
});

test('each render mints a fresh nonce (never a fixed/reused value)', () => {
  const a = getSidebarHtml(stubWebview(), { fsPath: '/ext' } as any, '1.0.0').match(/nonce-([^']+)'/)![1];
  const b = getSidebarHtml(stubWebview(), { fsPath: '/ext' } as any, '1.0.0').match(/nonce-([^']+)'/)![1];
  assert.notEqual(a, b);
  assert.ok(a.length >= 16, 'nonce should be non-trivial');
});

test('the passed version is rendered into the header', () => {
  const html = getSidebarHtml(stubWebview(), { fsPath: '/ext' } as any, '1.2.3');
  assert.match(html, /v1\.2\.3/);
});

/**
 * The MCP enable/disable and sign-out menu items only work if the click handler and the message
 * names the extension listens for line up. Both live in the same generated string, so a rename on
 * one side is silent — these pin the contract.
 */
test('the MCP more-menu posts toggleMcp for enable/disable and mcpLogout for sign out', () => {
  const html = getSidebarHtml(stubWebview(), { fsPath: '/ext' } as any, '1.0.0');
  assert.match(html, /menuItem\(off \? 'Enable' : 'Disable'/, 'the more-menu must offer enable/disable');
  assert.match(html, /data-act="mcpToggle"/, 'the menu item must carry the toggle action');
  assert.match(html, /type: 'toggleMcp', mcpName: name, enable/, 'the toggle must post toggleMcp');
  assert.match(html, /data-act="mcpLogout"/, 'the more-menu must offer sign out');
  assert.match(html, /type: 'mcpLogout', mcpName: name/, 'sign out must post mcpLogout');
  assert.doesNotMatch(html, /class="switch/, 'the always-visible switch must be gone');
});
