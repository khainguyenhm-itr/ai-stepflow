import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AccountManager } from '../../src/accountManager.js';

let dir: string;
const storePath = () => path.join(dir, 'sub', 'accounts.json');
const claudeJson = () => path.join(dir, '.claude.json');

beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'csf-acct-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('isSupported is true only on darwin', () => {
  assert.equal(new AccountManager({ platform: 'darwin' }).isSupported(), true);
  assert.equal(new AccountManager({ platform: 'linux' }).isSupported(), false);
});

test('peekCurrentLabel reads oauthAccount email from ~/.claude.json', () => {
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'ba@itrvn.com', displayName: 'BA', organizationName: 'ITR' } }));
  const m = new AccountManager({ claudeJsonPath: claudeJson() });
  assert.deepEqual(m.peekCurrentLabel(), { email: 'ba@itrvn.com', displayName: 'BA', organizationName: 'ITR' });
});

test('peekCurrentLabel returns null when oauthAccount or email is missing or file is malformed', () => {
  writeFileSync(claudeJson(), JSON.stringify({ somethingElse: 1 }));
  assert.equal(new AccountManager({ claudeJsonPath: claudeJson() }).peekCurrentLabel(), null);
  writeFileSync(claudeJson(), '{ not json');
  assert.equal(new AccountManager({ claudeJsonPath: claudeJson() }).peekCurrentLabel(), null);
  assert.equal(new AccountManager({ claudeJsonPath: path.join(dir, 'nope.json') }).peekCurrentLabel(), null);
});
