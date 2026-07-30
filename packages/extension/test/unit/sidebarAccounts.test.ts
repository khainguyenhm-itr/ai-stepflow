import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recorder } from './vscodeStub.js';
import { SidebarActions } from '../../src/sidebarActions.js';

beforeEach(() => recorder.reset());

// Minimal AccountManager double — only the methods SidebarActions calls.
function fakeAccounts() {
  const calls: string[] = [];
  return {
    calls,
    isSupported: () => true,
    peekCurrentLabel: () => ({ email: 'ba@itrvn.com' }),
    async switchTo(name: string) { calls.push('switchTo:' + name); },
    async saveCurrentAsAccount(name?: string) { calls.push('save:' + (name ?? '<none>')); return { name: name ?? 'ba@itrvn.com', email: 'ba@itrvn.com', savedAt: 't', active: true }; },
    async removeAccount(name: string) { calls.push('remove:' + name); },
    async listAccounts() { return []; },
    // no reLogin in v1
  };
}

function makeActions(acct: ReturnType<typeof fakeAccounts>) {
  let refreshed = 0;
  const actions = new SidebarActions(
    {} as any, {} as any,
    async () => { refreshed++; },
    () => undefined,
    () => [],
    acct as any,
  );
  return { actions, refreshed: () => refreshed };
}

test('switchAccount swaps the login, notifies, and refreshes', async () => {
  const acct = fakeAccounts();
  const { actions, refreshed } = makeActions(acct);
  await actions.switchAccount('work@x');
  assert.deepEqual(acct.calls, ['switchTo:work@x']);
  assert.equal(refreshed(), 1);
  assert.equal(recorder.infoMessages.length, 1);
});

test('saveCurrentAccount uses the detected email (no input box needed)', async () => {
  const acct = fakeAccounts();
  const { actions, refreshed } = makeActions(acct);
  await actions.saveCurrentAccount();
  assert.deepEqual(acct.calls, ['save:<none>']);
  assert.equal(refreshed(), 1);
});

test('saveCurrentAccount does not force the detected email as an explicit name (F1 regression guard)', async () => {
  const acct = fakeAccounts();
  const { actions } = makeActions(acct);
  await actions.saveCurrentAccount();
  // Must call saveCurrentAsAccount() with NO argument when an email is detected,
  // so the accountManager's fingerprint-match / collision-guard precedence runs
  // instead of the unconditional-overwrite explicit-name path.
  assert.deepEqual(acct.calls, ['save:<none>']);
});
