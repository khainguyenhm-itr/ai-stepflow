import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
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

/** Fake `security`: records argv, models both Keychain services in-memory. */
function makeExec(opts: { canonical?: string | null; store?: Record<string, string> } = {}) {
  const calls: string[][] = [];
  const store: Record<string, string> = { ...(opts.store ?? {}) };
  let canonical = opts.canonical ?? null;
  const svcOf = (a: string[]) => a[a.indexOf('-s') + 1];
  const acctOf = (a: string[]) => (a.indexOf('-a') >= 0 ? a[a.indexOf('-a') + 1] : '');
  const exec = async (args: string[]): Promise<string> => {
    calls.push(args);
    const sub = args[0];
    const svc = svcOf(args);
    const acct = acctOf(args);
    if (sub === 'find-generic-password') {
      if (svc === 'Claude Code-credentials') { if (canonical == null) throw new Error('not found'); return canonical + '\n'; }
      if (svc === 'ClaudeSteps-accounts') { if (!(acct in store)) throw new Error('not found'); return store[acct] + '\n'; }
    }
    if (sub === 'add-generic-password') {
      const w = args[args.indexOf('-w') + 1];
      if (svc === 'ClaudeSteps-accounts') store[acct] = w;
      if (svc === 'Claude Code-credentials') canonical = w;
      return '';
    }
    if (sub === 'delete-generic-password') { delete store[acct]; return ''; }
    return '';
  };
  return { exec, calls, store, get canonical() { return canonical; } };
}

const mgr = (fake: { exec: (a: string[]) => Promise<string> }, extra: object = {}) =>
  new AccountManager({ exec: fake.exec, osUsername: 'testuser', claudeJsonPath: claudeJson(), storePath: storePath(), now: () => '2026-07-30T00:00:00.000Z', ...extra });

test('saveCurrentAsAccount stores the blob under the email and upserts metadata', async () => {
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'ba@itrvn.com', displayName: 'BA', organizationName: 'ITR' } }));
  const fake = makeExec({ canonical: 'BLOB-1' });
  const view = await mgr(fake).saveCurrentAsAccount();
  assert.equal(view.email, 'ba@itrvn.com');
  assert.equal(view.active, true);
  assert.equal(fake.store['ba@itrvn.com'], 'BLOB-1');
  const meta = JSON.parse(readFileSync(storePath(), 'utf8')).accounts;
  assert.equal(meta.length, 1);
  assert.equal(meta[0].name, 'ba@itrvn.com');
  assert.equal(meta[0].organizationName, 'ITR');
  assert.equal(meta[0].savedAt, '2026-07-30T00:00:00.000Z');
  assert.match(meta[0].fingerprint, /^[0-9a-f]{64}$/);
});

test('saveCurrentAsAccount refuses when there is no current login', async () => {
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z' } }));
  const fake = makeExec({ canonical: null });
  await assert.rejects(() => mgr(fake).saveCurrentAsAccount(), /No current Claude login/);
});

test('saveCurrentAsAccount falls back to an explicit name when no email is present', async () => {
  writeFileSync(claudeJson(), JSON.stringify({ nope: 1 }));
  const fake = makeExec({ canonical: 'BLOB-2' });
  const view = await mgr(fake).saveCurrentAsAccount('manual');
  assert.equal(view.name, 'manual');
  assert.equal(view.email, 'manual'); // email falls back to the name
  assert.equal(fake.store['manual'], 'BLOB-2');
});

test('saveCurrentAsAccount with no name and no email throws', async () => {
  writeFileSync(claudeJson(), JSON.stringify({ nope: 1 }));
  const fake = makeExec({ canonical: 'BLOB-3' });
  await assert.rejects(() => mgr(fake).saveCurrentAsAccount(), /account name/);
});

test('saving the same name twice overwrites (refresh), not duplicates', async () => {
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'ba@itrvn.com' } }));
  const fake = makeExec({ canonical: 'BLOB-A' });
  const m = mgr(fake);
  await m.saveCurrentAsAccount();
  await m.saveCurrentAsAccount(); // canonical still BLOB-A
  const meta = JSON.parse(readFileSync(storePath(), 'utf8')).accounts;
  assert.equal(meta.length, 1);
});

test('switchTo writes the saved blob into the canonical Keychain slot', async () => {
  const fake = makeExec({ canonical: 'OLD', store: { 'work': 'WORK-BLOB' } });
  await mgr(fake).switchTo('work');
  assert.equal(fake.canonical, 'WORK-BLOB');
  const addCanonical = fake.calls.find(a => a[0] === 'add-generic-password' && a.includes('Claude Code-credentials'));
  assert.ok(addCanonical, 'must add-generic-password into the canonical service');
  assert.ok(addCanonical!.includes('-U'), 'must upsert with -U');
});

test('switchTo throws when the saved account is missing', async () => {
  const fake = makeExec({ canonical: 'OLD', store: {} });
  await assert.rejects(() => mgr(fake).switchTo('ghost'), /not found/);
});

test('removeAccount deletes the Keychain item and the metadata entry', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a', email: 'a', fingerprint: 'fa', savedAt: 't' },
    { name: 'b', email: 'b', fingerprint: 'fb', savedAt: 't' },
  ] }));
  const fake = makeExec({ canonical: 'OLD', store: { a: 'A', b: 'B' } });
  await mgr(fake).removeAccount('a');
  assert.equal('a' in fake.store, false);
  const meta = JSON.parse(readFileSync(storePath(), 'utf8')).accounts;
  assert.deepEqual(meta.map((m: { name: string }) => m.name), ['b']);
});
