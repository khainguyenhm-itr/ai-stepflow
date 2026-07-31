import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { AccountManager, type AccountMeta } from '../../src/accountManager.js';

const fp = (s: string) => createHash('sha256').update(s).digest('hex');

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
    if (sub === 'delete-generic-password') {
      if (svc === 'Claude Code-credentials') canonical = null; // models a Claude logout
      else delete store[acct];
      return '';
    }
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

test('saveCurrentAsAccount resolves by fingerprint after switchTo, preserving the other account (F1)', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a@x', email: 'a@x', fingerprint: fp('BLOB-A'), savedAt: 't' },
    { name: 'b@y', email: 'b@y', fingerprint: fp('BLOB-B'), savedAt: 't' },
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' } })); // stale label from A
  const fake = makeExec({ canonical: 'BLOB-B', store: { 'a@x': 'BLOB-A', 'b@y': 'BLOB-B' } });
  const view = await mgr(fake).saveCurrentAsAccount();
  assert.equal(view.name, 'b@y');
  assert.equal(fake.store['a@x'], 'BLOB-A'); // A not clobbered
  const meta = JSON.parse(readFileSync(storePath(), 'utf8')).accounts;
  assert.equal(meta.length, 2);
  const a = meta.find((m: AccountMeta) => m.name === 'a@x');
  assert.equal(a.fingerprint, fp('BLOB-A'));
});

test('saveCurrentAsAccount throws on stale-email collision instead of overwriting a different saved account (F1)', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a@x', email: 'a@x', fingerprint: fp('BLOB-A'), savedAt: 't' },
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' } })); // stale
  const fake = makeExec({ canonical: 'BLOB-C', store: { 'a@x': 'BLOB-A' } });
  await assert.rejects(() => mgr(fake).saveCurrentAsAccount(), /does not match saved account/);
  assert.equal(fake.store['a@x'], 'BLOB-A');
});

test('saveCurrentAsAccount with an explicit name still overwrites unconditionally (F1)', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a@x', email: 'a@x', fingerprint: fp('BLOB-A'), savedAt: 't' },
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' } }));
  const fake = makeExec({ canonical: 'BLOB-C', store: { 'a@x': 'BLOB-A' } });
  const view = await mgr(fake).saveCurrentAsAccount('a@x');
  assert.equal(view.name, 'a@x');
  assert.equal(fake.store['a@x'], 'BLOB-C');
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

test('saveCurrentAsAccount snapshots the full oauthAccount object into metadata', async () => {
  const oauth = { emailAddress: 'ba@itrvn.com', accountUuid: 'uuid-b', organizationUuid: 'org-b', displayName: 'BA', organizationName: 'ITR' };
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: oauth }));
  const fake = makeExec({ canonical: 'BLOB-1' });
  await mgr(fake).saveCurrentAsAccount();
  const meta = JSON.parse(readFileSync(storePath(), 'utf8')).accounts;
  assert.deepEqual(meta[0].oauthAccount, oauth);
});

test('saveCurrentAsAccount backfills oauthAccount for a previously-saved account when the current label matches', async () => {
  const oauthB = { emailAddress: 'b@y', accountUuid: 'uuid-b' };
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'b@y', email: 'b@y', fingerprint: fp('BLOB-B'), savedAt: 't' }, // no oauthAccount yet
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: oauthB })); // label matches the account
  const fake = makeExec({ canonical: 'BLOB-B', store: { 'b@y': 'BLOB-B' } });
  await mgr(fake).saveCurrentAsAccount();
  const meta = JSON.parse(readFileSync(storePath(), 'utf8')).accounts;
  assert.deepEqual(meta[0].oauthAccount, oauthB);
});

test('saveCurrentAsAccount keeps the existing snapshot when the current label is stale (mismatched)', async () => {
  const good = { emailAddress: 'b@y', accountUuid: 'uuid-b' };
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'b@y', email: 'b@y', fingerprint: fp('BLOB-B'), savedAt: 't', oauthAccount: good },
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' } })); // stale, different account
  const fake = makeExec({ canonical: 'BLOB-B', store: { 'b@y': 'BLOB-B' } });
  await mgr(fake).saveCurrentAsAccount();
  const meta = JSON.parse(readFileSync(storePath(), 'utf8')).accounts;
  assert.deepEqual(meta[0].oauthAccount, good); // NOT overwritten with the stale label
});

test('switchTo restores the saved oauthAccount into ~/.claude.json, preserving other keys', async () => {
  const oauthB = { emailAddress: 'b@y', accountUuid: 'uuid-b', displayName: 'B', organizationName: 'ORG' };
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'b@y', email: 'b@y', fingerprint: fp('WORK'), savedAt: 't', oauthAccount: oauthB },
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' }, numStartups: 42 }));
  const fake = makeExec({ canonical: 'OLD', store: { 'b@y': 'WORK' } });
  await mgr(fake).switchTo('b@y');
  const d = JSON.parse(readFileSync(claudeJson(), 'utf8'));
  assert.deepEqual(d.oauthAccount, oauthB);
  assert.equal(d.numStartups, 42); // unrelated keys preserved
});

test('switchTo clears a stale oauthAccount when the saved account has no snapshot', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'work', email: 'work', fingerprint: fp('WORK'), savedAt: 't' },
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'stale@x' }, numStartups: 7 }));
  const fake = makeExec({ canonical: 'OLD', store: { 'work': 'WORK' } });
  await mgr(fake).switchTo('work');
  const d = JSON.parse(readFileSync(claudeJson(), 'utf8'));
  assert.equal('oauthAccount' in d, false); // cleared so Claude refetches
  assert.equal(d.numStartups, 7);
});

test('switchTo does not throw when ~/.claude.json is absent', async () => {
  const fake = makeExec({ canonical: 'OLD', store: { 'work': 'WORK' } });
  await mgr(fake).switchTo('work'); // claudeJsonPath points at a non-existent file
  assert.equal(fake.canonical, 'WORK');
});

test('autoSaveIfNewLogin returns null on non-darwin', async () => {
  const fake = makeExec({ canonical: 'BLOB-NEW' });
  const view = await mgr(fake, { platform: 'linux' }).autoSaveIfNewLogin();
  assert.equal(view, null);
});

test('autoSaveIfNewLogin returns null when there is no current login', async () => {
  const fake = makeExec({ canonical: null });
  assert.equal(await mgr(fake).autoSaveIfNewLogin(), null);
});

test('autoSaveIfNewLogin skips a login whose fingerprint is already saved', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'ba@itrvn.com', email: 'ba@itrvn.com', fingerprint: fp('BLOB-B'), savedAt: 't' },
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'ba@itrvn.com' } }));
  const fake = makeExec({ canonical: 'BLOB-B', store: { 'ba@itrvn.com': 'BLOB-B' } });
  assert.equal(await mgr(fake).autoSaveIfNewLogin(), null);
});

test('autoSaveIfNewLogin returns null for a new login with no email to name it', async () => {
  writeFileSync(claudeJson(), JSON.stringify({ nope: 1 })); // no oauthAccount email
  const fake = makeExec({ canonical: 'BLOB-NEW' });
  assert.equal(await mgr(fake).autoSaveIfNewLogin(), null);
});

test('autoSaveIfNewLogin saves a new login and returns its view', async () => {
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'new@itrvn.com', displayName: 'New' } }));
  const fake = makeExec({ canonical: 'BLOB-NEW' });
  const view = await mgr(fake).autoSaveIfNewLogin();
  assert.equal(view?.email, 'new@itrvn.com');
  assert.equal(fake.store['new@itrvn.com'], 'BLOB-NEW');
});

test('autoSaveIfNewLogin swallows a save error (e.g. stale-email collision) and returns null', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a@x', email: 'a@x', fingerprint: fp('BLOB-A'), savedAt: 't' },
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' } })); // stale label, new blob
  const fake = makeExec({ canonical: 'BLOB-NEW', store: { 'a@x': 'BLOB-A' } });
  assert.equal(await mgr(fake).autoSaveIfNewLogin(), null);
  assert.equal(fake.store['a@x'], 'BLOB-A'); // untouched
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

test('listAccounts marks exactly the account matching the current login active', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a@x', email: 'a@x', fingerprint: fp('BLOB-A'), savedAt: 't' },
    { name: 'b@y', email: 'b@y', fingerprint: fp('BLOB-B'), savedAt: 't' },
  ] }));
  const fake = makeExec({ canonical: 'BLOB-B' });
  const list = await mgr(fake).listAccounts();
  assert.deepEqual(list.map((a: any) => [a.name, a.active]), [['a@x', false], ['b@y', true]]);
});

test('listAccounts marks none active when the current login matches no saved account', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a@x', email: 'a@x', fingerprint: fp('BLOB-A'), savedAt: 't' },
  ] }));
  const fake = makeExec({ canonical: null }); // read throws
  const list = await mgr(fake).listAccounts();
  assert.equal(list.every((a: any) => !a.active), true);
});

test('listAccounts returns [] when there is no metadata', async () => {
  const fake = makeExec({ canonical: 'X' });
  assert.deepEqual(await mgr(fake).listAccounts(), []);
});

test('listAccounts marks the account active by identity even after the OAuth token rotated (fingerprint changed)', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'sw@x', email: 'sw@x', fingerprint: fp('YESTERDAY-BLOB'), savedAt: 't', oauthAccount: { emailAddress: 'sw@x', accountUuid: 'uuid-sw' } },
  ] }));
  // Live login is the same account but the credential blob (token) has rotated → different fingerprint.
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'sw@x', accountUuid: 'uuid-sw' } }));
  const fake = makeExec({ canonical: 'TODAY-ROTATED-BLOB' });
  const list = await mgr(fake).listAccounts();
  assert.deepEqual(list.map(a => [a.name, a.active]), [['sw@x', true]]);
});

test('reconcileOnChange refreshes the stored credential when the active account token rotated', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'sw@x', email: 'sw@x', fingerprint: fp('OLD-BLOB'), savedAt: 't', oauthAccount: { emailAddress: 'sw@x', accountUuid: 'uuid-sw' } },
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'sw@x', accountUuid: 'uuid-sw' } }));
  const fake = makeExec({ canonical: 'NEW-ROTATED-BLOB', store: { 'sw@x': 'OLD-BLOB' } });
  const res = await mgr(fake, { platform: 'darwin' }).reconcileOnChange();
  assert.equal(res.autoSaved, null); // recognized as the same account, not a new one
  assert.equal(res.removed, null);
  assert.equal(fake.store['sw@x'], 'NEW-ROTATED-BLOB'); // stored credential refreshed
  const meta = JSON.parse(readFileSync(storePath(), 'utf8')).accounts;
  assert.equal(meta.length, 1); // no duplicate account created
  assert.equal(meta[0].fingerprint, fp('NEW-ROTATED-BLOB')); // fingerprint updated to the live token
});

test('reconcileOnChange forgets the active account on logout (credential + profile gone)', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a@x', email: 'a@x', fingerprint: fp('BLOB-A'), savedAt: 't' },
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' } }));
  const fake = makeExec({ canonical: 'BLOB-A', store: { 'a@x': 'BLOB-A' } });
  const m = mgr(fake, { platform: 'darwin' });
  await m.reconcileOnChange(); // observes a@x as the active login
  // logout: Claude removes the credential and clears the profile
  await fake.exec(['delete-generic-password', '-s', 'Claude Code-credentials', '-a', 'testuser']);
  writeFileSync(claudeJson(), JSON.stringify({ numStartups: 1 }));
  const res = await m.reconcileOnChange();
  assert.equal(res.removed, 'a@x');
  assert.equal(JSON.parse(readFileSync(storePath(), 'utf8')).accounts.length, 0);
});

test('reconcileOnChange switches to another saved account after a real logout', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a@x', email: 'a@x', fingerprint: fp('BLOB-A'), savedAt: '2026-01-01T00:00:00.000Z' },
    { name: 'b@y', email: 'b@y', fingerprint: fp('BLOB-B'), savedAt: '2026-02-01T00:00:00.000Z' }, // newer
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' } }));
  const fake = makeExec({ canonical: 'BLOB-A', store: { 'a@x': 'BLOB-A', 'b@y': 'BLOB-B' } });
  const m = mgr(fake, { platform: 'darwin' });
  await m.reconcileOnChange(); // active a@x
  await fake.exec(['delete-generic-password', '-s', 'Claude Code-credentials', '-a', 'testuser']);
  writeFileSync(claudeJson(), JSON.stringify({}));
  const res = await m.reconcileOnChange();
  assert.equal(res.removed, 'a@x');
  assert.equal(res.switchedTo, 'b@y'); // most-recently-saved remaining account
  assert.equal(fake.canonical, 'BLOB-B'); // credential swapped into the canonical slot
  const meta = JSON.parse(readFileSync(storePath(), 'utf8')).accounts;
  assert.deepEqual(meta.map((x: AccountMeta) => x.name), ['b@y']);
});

test('reconcileOnChange does NOT remove on a login-over (switch to another account)', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a@x', email: 'a@x', fingerprint: fp('BLOB-A'), savedAt: 't' },
    { name: 'b@y', email: 'b@y', fingerprint: fp('BLOB-B'), savedAt: 't' },
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' } }));
  const fake = makeExec({ canonical: 'BLOB-A', store: { 'a@x': 'BLOB-A', 'b@y': 'BLOB-B' } });
  const m = mgr(fake, { platform: 'darwin' });
  await m.reconcileOnChange(); // active a@x
  // login-over: a different account becomes active; the credential is never gone
  await fake.exec(['add-generic-password', '-U', '-s', 'Claude Code-credentials', '-a', 'testuser', '-w', 'BLOB-B']);
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'b@y' } }));
  const res = await m.reconcileOnChange();
  assert.equal(res.removed, null);
  assert.equal(JSON.parse(readFileSync(storePath(), 'utf8')).accounts.length, 2);
});

test('reconcileOnChange auto-saves a brand-new login', async () => {
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'new@itrvn.com' } }));
  const fake = makeExec({ canonical: 'BLOB-NEW' });
  const res = await mgr(fake, { platform: 'darwin' }).reconcileOnChange();
  assert.equal(res.autoSaved?.email, 'new@itrvn.com');
  assert.equal(fake.store['new@itrvn.com'], 'BLOB-NEW');
});

test('reconcileOnChange removes nothing on logout when no active account was ever observed', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a@x', email: 'a@x', fingerprint: fp('BLOB-A'), savedAt: 't' },
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ numStartups: 1 })); // already logged out
  const fake = makeExec({ canonical: null });
  const res = await mgr(fake, { platform: 'darwin' }).reconcileOnChange();
  assert.equal(res.removed, null);
  assert.equal(JSON.parse(readFileSync(storePath(), 'utf8')).accounts.length, 1);
});

test('noteActiveAccount seeds the active account so a later logout removes it', async () => {
  mkdirSync(path.dirname(storePath()), { recursive: true });
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a@x', email: 'a@x', fingerprint: fp('BLOB-A'), savedAt: 't' },
  ] }));
  writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { emailAddress: 'a@x' } }));
  const fake = makeExec({ canonical: 'BLOB-A', store: { 'a@x': 'BLOB-A' } });
  const m = mgr(fake, { platform: 'darwin' });
  await m.noteActiveAccount(); // seed without any prior reconcile
  await fake.exec(['delete-generic-password', '-s', 'Claude Code-credentials', '-a', 'testuser']);
  writeFileSync(claudeJson(), JSON.stringify({}));
  const res = await m.reconcileOnChange();
  assert.equal(res.removed, 'a@x');
});
