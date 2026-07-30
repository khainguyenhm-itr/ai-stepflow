# Claude Multi-Account Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user save several logged-in Claude accounts and switch between them from the extension sidebar, with everything in `~/.claude` shared and only the login (macOS Keychain credential) swapped.

**Architecture:** A vscode-free `AccountManager` wraps the macOS `security` CLI (injectable `exec` for tests): it reads the canonical Keychain credential (`service="Claude Code-credentials"`), stores copies as its own Keychain items (`service="ClaudeSteps-accounts"`), and keeps non-secret metadata (email/fingerprint/timestamp) in a JSON file under the extension's `globalStorage`. The sidebar (existing `WebviewViewProvider` message-passing) renders the account list and delegates actions to `SidebarActions`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, `node:child_process` (`security`), `node:crypto` (sha256), VS Code Webview API.

## Global Constraints

- **Platform:** macOS only. When `process.platform !== 'darwin'`, `isSupported()` is false and the sidebar section is hidden. No crash on other platforms.
- **Secrets:** the credential blob is never written to a plaintext file and never logged or shown in a message. Only Keychain holds blobs; the metadata file holds email/fingerprint/timestamp only.
- **Exact Keychain identifiers:** canonical service `Claude Code-credentials` (account = OS username); our store service `ClaudeSteps-accounts` (account = the account name).
- **Tests:** `node:test`, run via `npm run test:unit-ext`. Extension test files live in `packages/extension/test/unit/*.test.ts`, import source as `../../src/<mod>.js`. The `vscode` bare specifier is stubbed by `vscodeLoader.mjs`/`vscodeStub.ts`.
- **Follow the sidebar pattern:** webview posts `{ type, ... }`; `SidebarProvider.onDidReceiveMessage` switches on `type` and delegates to `SidebarActions`; `refresh()` posts a single `data` message the client renders.
- **UI shape (revised 2026-07-30):** the switcher is a `<select>` inside the **existing Settings section** (`settings-panel`), styled like the `review-kit-select` row — NOT a dedicated section. No "Re-login" control in v1.

## Current status (2026-07-30)

- **Tasks 1–3: DONE & committed.** `accountManager.ts` already implements `isSupported`, `peekCurrentLabel`, `readCanonicalBlob`, `saveCurrentAsAccount`, `switchTo`, `removeAccount`; 11 unit tests pass via `npm run test:unit-ext`. (The Task 3 test additions are staged in the working tree — commit them if not already.)
- **Task 4 (`listAccounts`): TODO** — the method and its tests do not exist yet.
- **Tasks 5–6: TODO and REVISED below** for the dropdown-in-Settings UI. Ignore any earlier "section + Re-login" wording; the current Task 5/6 bodies are authoritative.

---

### Task 1: AccountManager scaffolding — deps, metadata store, label reader  ✅ DONE (committed)

**Files:**
- Create: `packages/extension/src/accountManager.ts`
- Test: `packages/extension/test/unit/accountManager.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type SecurityExec = (args: string[]) => Promise<string>` — runs `security <args>`, resolves stdout, rejects on non-zero.
  - `interface AccountManagerDeps { exec?: SecurityExec; osUsername?: string; claudeJsonPath?: string; storePath?: string; platform?: NodeJS.Platform; now?: () => string; }`
  - `interface AccountMeta { name: string; email: string; displayName?: string; organizationName?: string; fingerprint: string; savedAt: string; }`
  - `interface AccountView { name: string; email: string; displayName?: string; organizationName?: string; savedAt: string; active: boolean; }`
  - `interface OauthLabel { email: string; displayName?: string; organizationName?: string; }`
  - `class AccountManager` with `isSupported(): boolean` and `peekCurrentLabel(): OauthLabel | null` (private helpers `fingerprint`, `readMeta`, `writeMeta` used by later tasks).

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/test/unit/accountManager.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit-ext`
Expected: FAIL — cannot find module `../../src/accountManager.js` / `AccountManager is not defined`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/extension/src/accountManager.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, userInfo } from 'node:os';

const execFileP = promisify(execFile);

export const CLAUDE_SERVICE = 'Claude Code-credentials';
export const STORE_SERVICE = 'ClaudeSteps-accounts';

export type SecurityExec = (args: string[]) => Promise<string>;

export interface AccountManagerDeps {
  exec?: SecurityExec;
  osUsername?: string;
  claudeJsonPath?: string;
  storePath?: string;
  platform?: NodeJS.Platform;
  now?: () => string;
}

export interface AccountMeta {
  name: string;
  email: string;
  displayName?: string;
  organizationName?: string;
  fingerprint: string;
  savedAt: string;
}

export interface AccountView {
  name: string;
  email: string;
  displayName?: string;
  organizationName?: string;
  savedAt: string;
  active: boolean;
}

export interface OauthLabel {
  email: string;
  displayName?: string;
  organizationName?: string;
}

const defaultExec: SecurityExec = async (args) => {
  const { stdout } = await execFileP('security', args);
  return stdout;
};

/**
 * Manages saved Claude logins by swapping the single macOS Keychain credential.
 * vscode-free and fully injectable so it runs under `node --test` without a real Keychain.
 */
export class AccountManager {
  private readonly exec: SecurityExec;
  private readonly osUsername: string;
  private readonly claudeJsonPath: string;
  private readonly storePath: string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => string;

  constructor(deps: AccountManagerDeps = {}) {
    this.exec = deps.exec ?? defaultExec;
    this.osUsername = deps.osUsername ?? userInfo().username;
    this.claudeJsonPath = deps.claudeJsonPath ?? join(homedir(), '.claude.json');
    this.storePath = deps.storePath ?? join(homedir(), '.claude', 'claudesteps-accounts.json');
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  isSupported(): boolean {
    return this.platform === 'darwin';
  }

  /** Non-secret account label from ~/.claude.json; reflects the *active* login only. */
  peekCurrentLabel(): OauthLabel | null {
    try {
      const d = JSON.parse(readFileSync(this.claudeJsonPath, 'utf8'));
      const oa = d?.oauthAccount;
      if (!oa || !oa.emailAddress) return null;
      return { email: oa.emailAddress, displayName: oa.displayName, organizationName: oa.organizationName };
    } catch {
      return null;
    }
  }

  protected fingerprint(blob: string): string {
    return createHash('sha256').update(blob).digest('hex');
  }

  protected readMeta(): AccountMeta[] {
    if (!existsSync(this.storePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.storePath, 'utf8'));
      return Array.isArray(parsed?.accounts) ? parsed.accounts : [];
    } catch {
      return [];
    }
  }

  protected writeMeta(accounts: AccountMeta[]): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    writeFileSync(this.storePath, JSON.stringify({ accounts }, null, 2));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit-ext`
Expected: PASS (all three Task 1 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/accountManager.ts packages/extension/test/unit/accountManager.test.ts
git commit -m "feat: AccountManager scaffolding (deps, metadata store, label reader)"
```

---

### Task 2: readCanonicalBlob + saveCurrentAsAccount  ✅ DONE (committed)

**Files:**
- Modify: `packages/extension/src/accountManager.ts`
- Test: `packages/extension/test/unit/accountManager.test.ts`

**Interfaces:**
- Consumes: `SecurityExec`, `readMeta`/`writeMeta`/`fingerprint`/`peekCurrentLabel` from Task 1.
- Produces: `saveCurrentAsAccount(name?: string): Promise<AccountView>` — reads the canonical blob, refuses if empty, derives the name from the current email when `name` is omitted, stores the blob as a `ClaudeSteps-accounts` item keyed by that name, and upserts metadata.

- [ ] **Step 1: Write the failing test**

```ts
// append to accountManager.test.ts

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit-ext`
Expected: FAIL — `saveCurrentAsAccount is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add these methods to `AccountManager`:

```ts
  private async readCanonicalBlob(): Promise<string> {
    const out = await this.exec(['find-generic-password', '-w', '-s', CLAUDE_SERVICE, '-a', this.osUsername]);
    return out.trim();
  }

  /** Snapshot the current login as a named account. Name defaults to the active email. */
  async saveCurrentAsAccount(name?: string): Promise<AccountView> {
    let blob = '';
    try { blob = await this.readCanonicalBlob(); } catch { blob = ''; }
    if (!blob) throw new Error('No current Claude login found in Keychain.');
    const label = this.peekCurrentLabel();
    const finalName = name ?? label?.email;
    if (!finalName) throw new Error('Could not determine an account name; provide one explicitly.');
    await this.exec(['add-generic-password', '-U', '-s', STORE_SERVICE, '-a', finalName, '-w', blob]);
    const entry: AccountMeta = {
      name: finalName,
      email: label?.email ?? finalName,
      displayName: label?.displayName,
      organizationName: label?.organizationName,
      fingerprint: this.fingerprint(blob),
      savedAt: this.now(),
    };
    this.writeMeta([...this.readMeta().filter(a => a.name !== finalName), entry]);
    return { ...entry, active: true };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit-ext`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/accountManager.ts packages/extension/test/unit/accountManager.test.ts
git commit -m "feat: AccountManager.saveCurrentAsAccount (capture current login)"
```

---

### Task 3: switchTo + removeAccount  ✅ DONE (commit the staged test if needed)

**Files:**
- Modify: `packages/extension/src/accountManager.ts`
- Test: `packages/extension/test/unit/accountManager.test.ts`

**Interfaces:**
- Consumes: Task 2 fake `makeExec`/`mgr` helpers, `readMeta`/`writeMeta`.
- Produces:
  - `switchTo(name: string): Promise<void>` — writes the saved account's blob into the canonical slot; throws if the saved item is missing.
  - `removeAccount(name: string): Promise<void>` — deletes the saved Keychain item (idempotent) and its metadata entry.

- [ ] **Step 1: Write the failing test**

```ts
// append to accountManager.test.ts

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit-ext`
Expected: FAIL — `switchTo is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `AccountManager`:

```ts
  /** Make a saved account the active login by overwriting the canonical Keychain slot. */
  async switchTo(name: string): Promise<void> {
    let blob = '';
    try {
      blob = (await this.exec(['find-generic-password', '-w', '-s', STORE_SERVICE, '-a', name])).trim();
    } catch {
      throw new Error(`Saved account '${name}' not found.`);
    }
    if (!blob) throw new Error(`Saved account '${name}' has no stored credential.`);
    await this.exec(['add-generic-password', '-U', '-s', CLAUDE_SERVICE, '-a', this.osUsername, '-w', blob]);
  }

  /** Forget a saved account (Keychain item + metadata). Safe if the item is already gone. */
  async removeAccount(name: string): Promise<void> {
    try { await this.exec(['delete-generic-password', '-s', STORE_SERVICE, '-a', name]); } catch { /* already gone */ }
    this.writeMeta(this.readMeta().filter(a => a.name !== name));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit-ext`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/accountManager.ts packages/extension/test/unit/accountManager.test.ts
git commit -m "feat: AccountManager.switchTo + removeAccount"
```

---

### Task 4: listAccounts (with active detection)

**Files:**
- Modify: `packages/extension/src/accountManager.ts`
- Test: `packages/extension/test/unit/accountManager.test.ts`

**Interfaces:**
- Consumes: Task 2/3 helpers, `readMeta`, `fingerprint`, `readCanonicalBlob`.
- Produces: `listAccounts(): Promise<AccountView[]>` — metadata mapped to views; `active === true` for the one whose fingerprint matches the current canonical blob; all inactive when the canonical read fails or matches nothing.

- [ ] **Step 1: Write the failing test**

```ts
// append to accountManager.test.ts
import { createHash } from 'node:crypto';
const fp = (s: string) => createHash('sha256').update(s).digest('hex');

test('listAccounts marks exactly the account matching the current login active', async () => {
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a@x', email: 'a@x', fingerprint: fp('BLOB-A'), savedAt: 't' },
    { name: 'b@y', email: 'b@y', fingerprint: fp('BLOB-B'), savedAt: 't' },
  ] }));
  const fake = makeExec({ canonical: 'BLOB-B' });
  const list = await mgr(fake).listAccounts();
  assert.deepEqual(list.map(a => [a.name, a.active]), [['a@x', false], ['b@y', true]]);
});

test('listAccounts marks none active when the current login matches no saved account', async () => {
  writeFileSync(storePath(), JSON.stringify({ accounts: [
    { name: 'a@x', email: 'a@x', fingerprint: fp('BLOB-A'), savedAt: 't' },
  ] }));
  const fake = makeExec({ canonical: null }); // read throws
  const list = await mgr(fake).listAccounts();
  assert.equal(list.every(a => !a.active), true);
});

test('listAccounts returns [] when there is no metadata', async () => {
  const fake = makeExec({ canonical: 'X' });
  assert.deepEqual(await mgr(fake).listAccounts(), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit-ext`
Expected: FAIL — `listAccounts is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `AccountManager`:

```ts
  /** All saved accounts, flagging the one that matches the current login. */
  async listAccounts(): Promise<AccountView[]> {
    let activeFp: string | null = null;
    try {
      const blob = await this.readCanonicalBlob();
      activeFp = blob ? this.fingerprint(blob) : null;
    } catch {
      activeFp = null;
    }
    return this.readMeta().map(a => ({
      name: a.name,
      email: a.email,
      displayName: a.displayName,
      organizationName: a.organizationName,
      savedAt: a.savedAt,
      active: activeFp !== null && a.fingerprint === activeFp,
    }));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit-ext`
Expected: PASS. AccountManager is now feature-complete.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/accountManager.ts packages/extension/test/unit/accountManager.test.ts
git commit -m "feat: AccountManager.listAccounts with active detection"
```

---

### Task 5: Sidebar actions + provider wiring

**Files:**
- Modify: `packages/extension/src/sidebarActions.ts`
- Modify: `packages/extension/src/sidebarProvider.ts`
- Modify: `packages/extension/src/extension.ts` (construct `AccountManager`, pass it in)
- Test: `packages/extension/test/unit/sidebarAccounts.test.ts`

**Interfaces:**
- Consumes: `AccountManager` (Tasks 1–4).
- Produces (on `SidebarActions`): `saveCurrentAccount()`, `switchAccount(name)`, `removeAccountAction(name)`. Provider `refresh()` adds `accounts` to the `data` message; provider handles message types `accountSaveCurrent`, `accountSwitch`, `accountRemove`. (No `reLoginAccount` in v1.)

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/test/unit/sidebarAccounts.test.ts
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
    async saveCurrentAsAccount(name?: string) { calls.push('save:' + (name ?? '')); return { name: name ?? 'ba@itrvn.com', email: 'ba@itrvn.com', savedAt: 't', active: true }; },
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
  assert.deepEqual(acct.calls, ['save:ba@itrvn.com']);
  assert.equal(refreshed(), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit-ext`
Expected: FAIL — `SidebarActions` constructor takes 5 args / `switchAccount is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `sidebarActions.ts`, import the type and add the constructor param + methods:

```ts
// add near the other imports
import type { AccountManager } from './accountManager.js';
```

```ts
// extend the constructor parameter list (append this last param)
    private readonly getCachedMcp: () => McpServer[],
    private readonly accounts: AccountManager,
  ) {}
```

```ts
  /** Save the current login as an account, labeled by the active email when available. */
  async saveCurrentAccount(): Promise<void> {
    let name = this.accounts.peekCurrentLabel()?.email;
    if (!name) {
      name = await vscode.window.showInputBox({ prompt: 'Name this Claude account (no email detected)', placeHolder: 'e.g. work@company.com' });
      if (!name) return;
    }
    try {
      const view = await this.accounts.saveCurrentAsAccount(name);
      vscode.window.showInformationMessage(`ClaudeSteps: saved account ${view.email}.`);
      await this.refresh(false);
    } catch (e) {
      vscode.window.showErrorMessage(`ClaudeSteps: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Make a saved account the active login (global to the whole machine). */
  async switchAccount(name: string): Promise<void> {
    try {
      await this.accounts.switchTo(name);
      vscode.window.showInformationMessage(`ClaudeSteps: switched to ${name}. Running Claude sessions keep the old login until restarted.`);
      await this.refresh(false);
    } catch (e) {
      vscode.window.showErrorMessage(`ClaudeSteps: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Forget a saved account after confirmation. */
  async removeAccountAction(name: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(`Remove saved account '${name}'?`, { modal: true }, 'Remove');
    if (choice !== 'Remove') return;
    await this.accounts.removeAccount(name);
    await this.refresh(false);
  }
```

In `sidebarProvider.ts`:

```ts
// add import
import { AccountManager } from './accountManager.js';
```

```ts
// add a constructor parameter (after `version`) and pass it into SidebarActions
  constructor(
    private readonly extensionUri: vscode.Uri,
    private configManager: ConfigManager,
    private stateManager: StateManager,
    private readonly version: string,
    private readonly accountManager: AccountManager,
  ) {
    this._actions = new SidebarActions(
      configManager,
      stateManager,
      (probeMcp) => this.refresh(probeMcp),
      () => this._view,
      () => this._cachedMcp,
      accountManager,
    );
  }
```

Extend the `onDidReceiveMessage` parameter type to include `name?: string`, and add cases (place beside the other cases):

```ts
            case 'accountSaveCurrent':
              await this._actions.saveCurrentAccount();
              return;
            case 'accountSwitch':
              if ((message as any).name) await this._actions.switchAccount((message as any).name);
              return;
            case 'accountRemove':
              if ((message as any).name) await this._actions.removeAccountAction((message as any).name);
              return;
```

In `refresh()`, gather and include accounts. Add to the `Promise.all` array and destructure:

```ts
        this.configManager.loadReviewKits().catch(() => []),
        this.accountManager.isSupported() ? this.accountManager.listAccounts().catch(() => []) : Promise.resolve(null),
      ]);
```
Update the destructuring to add a trailing `accounts` binding, and add `accounts` to the `postMessage({ type: 'data', ... })` payload:

```ts
        activeRun: active,
        accounts,
```

In `extension.ts`, construct the manager and pass it in (needs `context.globalStorageUri`):

```ts
// add imports
import { AccountManager } from './accountManager.js';
import { join } from 'node:path';
```

```ts
// before `const sidebar = new SidebarProvider(...)`
    const accountManager = new AccountManager({
      storePath: join(context.globalStorageUri.fsPath, 'claude-accounts.json'),
    });
    const sidebar = new SidebarProvider(context.extensionUri, configManager, stateManager, version, accountManager);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit-ext`
Expected: PASS. Then `npm run compile` to confirm the provider/extension wiring type-checks.

Manual verification (needs the VS Code host, not unit-testable with the current stub): the "Save current login…" input-box fallback and the "Remove" modal confirmation.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidebarActions.ts packages/extension/src/sidebarProvider.ts packages/extension/src/extension.ts packages/extension/test/unit/sidebarAccounts.test.ts
git commit -m "feat: wire AccountManager into sidebar actions + provider"
```

---

### Task 6: Sidebar HTML — Claude Account switcher (dropdown in Settings)

**Files:**
- Modify: `packages/extension/src/sidebarHtml.ts`
- Test: `packages/extension/test/unit/sidebarHtml.test.ts`

**Interfaces:**
- Consumes: the `data` message's `accounts: AccountView[] | null` (Task 5). `null` = unsupported platform.
- Produces: a `setting-row` inside the existing `settings-panel` holding `<select id="account-select">`, `<button id="account-save-btn">`, and `<button id="account-remove-btn">`; client JS populates the select from `accounts` and posts `accountSwitch` (on select change), `accountSaveCurrent` (Save button), `accountRemove` (Remove button).

- [ ] **Step 1: Write the failing test**

```ts
// append to sidebarHtml.test.ts
test('sidebar Settings includes the Claude Account switcher (select + save/remove)', () => {
  const html = getSidebarHtml(stubWebview(), { fsPath: '/ext' } as any, '9.9.9');
  assert.match(html, /id="account-select"/);
  assert.match(html, /id="account-save-btn"/);
  assert.match(html, /id="account-remove-btn"/);
  // the client posts account messages
  assert.match(html, /accountSwitch/);
  assert.match(html, /accountSaveCurrent/);
  assert.match(html, /accountRemove/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit-ext`
Expected: FAIL — no `id="account-select"` in the markup.

- [ ] **Step 3: Write minimal implementation**

In `sidebarHtml.ts`, add a `setting-row` inside the `settings-panel`, right after the Review Kit row (the `review-kit-select` row) and before the `gitnexus-setting-row`. Mirror the existing `select-wrap sm` styling:

```html
        <div class="setting-row" id="account-setting-row">
          <div>
            <div class="setting-label">Claude Account</div>
            <div class="setting-desc">Active login — switching applies to all Claude on this machine</div>
          </div>
          <div class="account-ctl">
            <span class="select-wrap sm"><select id="account-select" class="input sm"></select></span>
            <button class="pill sm" id="account-save-btn" type="button" title="Save the current login as an account">&#43; Save</button>
            <button class="pill sm" id="account-remove-btn" type="button" title="Remove the selected account">&#128465;</button>
          </div>
        </div>
```

In the client `<script nonce="...">`, add a `renderAccounts` function next to `renderReviewKits` (reuses the existing `esc` helper). The select shows one option per account; the active one is `selected`; when none is active (external login) a leading disabled placeholder is selected; `null` accounts hides the whole row (unsupported platform):

```js
  // Populate the account switcher. accounts === null => unsupported platform (hide the row).
  function renderAccounts(accounts) {
    const row = document.getElementById('account-setting-row');
    const sel = document.getElementById('account-select');
    if (!row || !sel) return;
    if (accounts == null) { row.style.display = 'none'; return; }
    row.style.display = '';
    if (!accounts.length) {
      sel.innerHTML = '<option value="" disabled selected>No saved accounts</option>';
      return;
    }
    const hasActive = accounts.some(a => a.active);
    const placeholder = hasActive ? '' : '<option value="" disabled selected>&#8212; external login &#8212;</option>';
    sel.innerHTML = placeholder + accounts.map(a =>
      '<option value="' + esc(a.name) + '"' + (a.active ? ' selected' : '') + '>' + esc(a.email) + '</option>'
    ).join('');
  }
```

Call `renderAccounts(m.accounts)` in the `data`-message handler, right after the `renderReviewKits(...)` line (around line 1098):

```js
        renderAccounts(m.accounts);
```

Wire the controls once during init, next to the `review-kit-select` change handler (around line 1135). The elements always exist in the markup (the row is only hidden, never removed), matching the existing unconditional `addEventListener` pattern:

```js
  document.getElementById('account-select').addEventListener('change', function() {
    if (this.value) vscode.postMessage({ type: 'accountSwitch', name: this.value });
  });
  document.getElementById('account-save-btn').addEventListener('click', function() {
    vscode.postMessage({ type: 'accountSaveCurrent' });
  });
  document.getElementById('account-remove-btn').addEventListener('click', function() {
    const sel = document.getElementById('account-select');
    if (sel && sel.value) vscode.postMessage({ type: 'accountRemove', name: sel.value });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit-ext`
Expected: PASS (new test + the existing CSP/nonce tests still pass).

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidebarHtml.ts packages/extension/test/unit/sidebarHtml.test.ts
git commit -m "feat: sidebar Claude Account switcher (dropdown in Settings)"
```

---

## Final verification

- [ ] Run the full extension unit suite: `npm run test:unit-ext` — all green.
- [ ] Type-check the whole build: `npm run compile`.
- [ ] Manual (VS Code host): open the sidebar → Settings section → the **Claude Account** row shows a dropdown. Click **＋ Save** once → it lists `ba@itrvn.com` and selects it. Add a second login (in a terminal, log in as another account, then ＋ Save) → the dropdown lists both, active one selected. Changing the dropdown swaps the login (confirm via a fresh `claude` run). **🗑** removes the selected account after confirm. On non-macOS the row is hidden. On the first `security` read, approve the Keychain "Allow" prompt.
