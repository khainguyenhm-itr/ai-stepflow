import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { recorder } from './vscodeStub.js';
import { SidebarActions } from '../../src/sidebarActions.js';

beforeEach(() => recorder.reset());

type AcctView = { name: string; email: string; savedAt: string; active: boolean };

// Minimal AccountManager double — only the methods SidebarActions calls.
function fakeAccounts(list: AcctView[] = []) {
  const calls: string[] = [];
  return {
    calls,
    isSupported: () => true,
    peekCurrentLabel: () => ({ email: 'ba@itrvn.com' }),
    async switchTo(name: string) { calls.push('switchTo:' + name); },
    async removeAccount(name: string) { calls.push('remove:' + name); },
    async listAccounts() { return list; },
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

test('pickAndRemoveAccount informs and does nothing when there are no saved accounts', async () => {
  const acct = fakeAccounts([]);
  const { actions, refreshed } = makeActions(acct);
  await actions.pickAndRemoveAccount();
  assert.deepEqual(acct.calls, []);
  assert.equal(recorder.infoMessages.length, 1);
  assert.equal(refreshed(), 0);
});

test('pickAndRemoveAccount removes the picked account after the user confirms', async () => {
  const acct = fakeAccounts([{ name: 'work@x', email: 'work@x', savedAt: 't', active: false }]);
  const { actions, refreshed } = makeActions(acct);
  recorder.quickPickResult = { name: 'work@x' };
  recorder.warnResult = 'Remove'; // confirm
  await actions.pickAndRemoveAccount();
  assert.deepEqual(acct.calls, ['remove:work@x']);
  assert.equal(refreshed(), 1);
});

test('pickAndRemoveAccount does nothing when the picker is dismissed', async () => {
  const acct = fakeAccounts([{ name: 'work@x', email: 'work@x', savedAt: 't', active: false }]);
  const { actions } = makeActions(acct);
  recorder.quickPickResult = undefined; // dismissed
  await actions.pickAndRemoveAccount();
  assert.deepEqual(acct.calls, []);
});

test('pickAndRemoveAccount does not remove when the confirm is declined', async () => {
  const acct = fakeAccounts([{ name: 'work@x', email: 'work@x', savedAt: 't', active: false }]);
  const { actions } = makeActions(acct);
  recorder.quickPickResult = { name: 'work@x' };
  recorder.warnResult = undefined; // declined / dismissed confirm
  await actions.pickAndRemoveAccount();
  assert.deepEqual(acct.calls, []);
});
