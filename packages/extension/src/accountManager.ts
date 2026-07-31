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
  /** Full `oauthAccount` object snapshotted from ~/.claude.json at save time, so switchTo can
   *  restore the profile label Claude Code shows in `/status` (the Keychain swap alone leaves it stale). */
  oauthAccount?: Record<string, unknown>;
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
  /** Per-process memory of the account currently logged in, so a later logout knows which saved
   *  account to forget — by then the credential is gone and can't be re-identified by fingerprint. */
  private lastActiveName: string | null = null;

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

  /** Raw `oauthAccount` object from ~/.claude.json (the full profile, not just the label). */
  protected peekCurrentOauthAccount(): Record<string, unknown> | undefined {
    try {
      const d = JSON.parse(readFileSync(this.claudeJsonPath, 'utf8'));
      const oa = d?.oauthAccount;
      return oa && typeof oa === 'object' ? oa : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Set (or, when `snapshot` is undefined, remove) `oauthAccount` in ~/.claude.json, preserving every
   * other key. Best-effort: a missing snapshot leaves nothing to write when the file is absent, and a
   * malformed file is left untouched rather than risking corruption. The Keychain swap has already
   * succeeded by the time this runs.
   */
  protected applyOauthAccount(snapshot: Record<string, unknown> | undefined): void {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(readFileSync(this.claudeJsonPath, 'utf8'));
      if (!d || typeof d !== 'object') return;
    } catch {
      if (!snapshot) return; // no file and nothing to restore
      d = {};
    }
    if (snapshot) d.oauthAccount = snapshot;
    else delete d.oauthAccount;
    try {
      mkdirSync(dirname(this.claudeJsonPath), { recursive: true });
      writeFileSync(this.claudeJsonPath, JSON.stringify(d, null, 2));
    } catch { /* best-effort: leave ~/.claude.json as-is */ }
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

  private async readCanonicalBlob(): Promise<string> {
    const out = await this.exec(['find-generic-password', '-w', '-s', CLAUDE_SERVICE, '-a', this.osUsername]);
    return out.trim();
  }

  /** Snapshot the current login as a named account. Name defaults to the active email. */
  async saveCurrentAsAccount(name?: string): Promise<AccountView> {
    let blob = '';
    try { blob = await this.readCanonicalBlob(); } catch { blob = ''; }
    if (!blob) throw new Error('No current Claude login found in Keychain.');
    const fp = this.fingerprint(blob);
    const meta = this.readMeta();
    const label = this.peekCurrentLabel();

    let finalName: string | undefined = name;
    let matchedByFingerprint: AccountMeta | undefined;
    if (!finalName) {
      matchedByFingerprint = meta.find(a => a.fingerprint === fp);
      finalName = matchedByFingerprint?.name;
    }
    if (!finalName) {
      const email = label?.email;
      const collision = email ? meta.find(a => a.name === email && a.fingerprint !== fp) : undefined;
      if (collision) {
        throw new Error(`The current login does not match saved account '${email}'. Its profile may be stale — wait for the Claude session to initialize, or pass an explicit name.`);
      }
      finalName = email;
    }
    if (!finalName) throw new Error('Could not determine an account name; provide one explicitly.');

    await this.exec(['add-generic-password', '-U', '-s', STORE_SERVICE, '-a', finalName, '-w', blob]);
    const email = matchedByFingerprint ? matchedByFingerprint.email : (label?.email ?? finalName);
    // Trust ~/.claude.json's profile only when its email identifies the account we're saving; a stale
    // label left over from a previous switch must not be captured under this account (F1). When it
    // doesn't match, fall back to any snapshot already stored for this account.
    const current = this.peekCurrentOauthAccount();
    const currentEmail = typeof current?.emailAddress === 'string' ? current.emailAddress : undefined;
    const oauthAccount = current && (currentEmail === email || currentEmail === finalName)
      ? current
      : matchedByFingerprint?.oauthAccount;
    const entry: AccountMeta = matchedByFingerprint
      ? {
          name: finalName,
          email: matchedByFingerprint.email,
          displayName: matchedByFingerprint.displayName,
          organizationName: matchedByFingerprint.organizationName,
          fingerprint: fp,
          savedAt: this.now(),
          oauthAccount,
        }
      : {
          name: finalName,
          email: label?.email ?? finalName,
          displayName: label?.displayName,
          organizationName: label?.organizationName,
          fingerprint: fp,
          savedAt: this.now(),
          oauthAccount,
        };
    this.writeMeta([...meta.filter(a => a.name !== finalName), entry]);
    return { ...entry, active: true };
  }

  /** Stable identity of the currently-active login from ~/.claude.json. Unlike the credential blob's
   *  fingerprint, accountUuid/email do NOT change when Claude rotates the OAuth token. */
  private currentIdentity(): { uuid?: string; email?: string } {
    const oa = this.peekCurrentOauthAccount();
    return {
      uuid: typeof oa?.accountUuid === 'string' ? oa.accountUuid : undefined,
      email: typeof oa?.emailAddress === 'string' ? oa.emailAddress : undefined,
    };
  }

  /** Find the saved account matching a login identity — by accountUuid first, then email. */
  private matchByIdentity(meta: AccountMeta[], id: { uuid?: string; email?: string }): AccountMeta | undefined {
    if (id.uuid) { const m = meta.find(a => (a.oauthAccount?.accountUuid as string | undefined) === id.uuid); if (m) return m; }
    if (id.email) return meta.find(a => a.email === id.email);
    return undefined;
  }

  /** Re-store the live credential for an already-saved account whose token has rotated, so active
   *  detection and future switchTo keep working with a valid token. Best-effort; never throws. */
  private async refreshStoredCredential(name: string, blob: string, fp: string): Promise<void> {
    try { await this.exec(['add-generic-password', '-U', '-s', STORE_SERVICE, '-a', name, '-w', blob]); } catch { return; }
    const meta = this.readMeta();
    const idx = meta.findIndex(a => a.name === name);
    if (idx < 0) return;
    meta[idx] = { ...meta[idx], fingerprint: fp, oauthAccount: this.peekCurrentOauthAccount() ?? meta[idx].oauthAccount, savedAt: this.now() };
    this.writeMeta(meta);
  }

  /**
   * Auto-save hook: if the current login is a *new* one (its fingerprint is not already saved) and
   * carries an email to name it, snapshot it as an account. Returns the saved view, or null when there
   * is nothing to do — unsupported platform, no login, an already-known login, a nameless login, or a
   * save that the collision guard rejected. Never throws, so it is safe to call from a file watcher.
   */
  async autoSaveIfNewLogin(): Promise<AccountView | null> {
    if (!this.isSupported()) return null;
    let blob = '';
    try { blob = await this.readCanonicalBlob(); } catch { return null; }
    if (!blob) return null;
    const fp = this.fingerprint(blob);
    if (this.readMeta().some(a => a.fingerprint === fp)) return null; // already saved / just switched
    if (!this.peekCurrentLabel()?.email) return null; // no email to name it → leave to manual naming
    try {
      return await this.saveCurrentAsAccount();
    } catch {
      return null; // stale-email collision or Keychain hiccup — skip quietly
    }
  }

  /**
   * Prime the "active login" memory from the current Keychain/store without saving or changing
   * anything, so a logout that happens before any ~/.claude.json change still knows what to forget.
   * Safe to call at activation; a no-op off darwin, with no login, or when no saved account matches.
   */
  async noteActiveAccount(): Promise<void> {
    if (!this.isSupported()) return;
    let blob = '';
    try { blob = await this.readCanonicalBlob(); } catch { return; }
    if (!blob) return;
    const meta = this.readMeta();
    const saved = this.matchByIdentity(meta, this.currentIdentity()) ?? meta.find(a => a.fingerprint === this.fingerprint(blob));
    this.lastActiveName = saved?.name ?? this.lastActiveName;
  }

  /**
   * Reconcile saved accounts with the live login on every ~/.claude.json change, from any window.
   * Three transitions, so every open window stays in sync:
   *   - logout (Keychain credential AND active profile both gone) → forget the account that was
   *     active, then switch to another saved account if one remains so the user isn't left signed out;
   *   - new login → snapshot it (auto-save) and remember it as active;
   *   - switch / login-over (a known or freshly-saved login) → just remember the new active account.
   * A login-over never clears both signals, so it never triggers a removal. Never throws — safe to
   * call from a file watcher. Returns what changed so the caller can toast.
   */
  async reconcileOnChange(): Promise<{ autoSaved: AccountView | null; removed: string | null; switchedTo: string | null }> {
    const nothing = { autoSaved: null, removed: null, switchedTo: null };
    if (!this.isSupported()) return nothing;
    let blob = '';
    try { blob = await this.readCanonicalBlob(); } catch { blob = ''; }
    const loggedIn = !!this.peekCurrentLabel();

    // Logout: no credential and no active profile → forget the last-active account, then fall back
    // to another saved account if one remains.
    if (!blob && !loggedIn) {
      const name = this.lastActiveName;
      this.lastActiveName = null;
      let removed: string | null = null;
      if (name && this.readMeta().some(a => a.name === name)) {
        try { await this.removeAccount(name); removed = name; } catch { return nothing; }
      }
      // Pick the most recently saved remaining account (deterministic across windows) and switch to it.
      const next = [...this.readMeta()].sort((a, b) =>
        (b.savedAt || '').localeCompare(a.savedAt || '') || a.name.localeCompare(b.name))[0];
      if (next) {
        try {
          await this.switchTo(next.name);
          this.lastActiveName = next.name;
          return { autoSaved: null, removed, switchedTo: next.name };
        } catch { /* fall through: stay signed out */ }
      }
      return { autoSaved: null, removed, switchedTo: null };
    }

    if (blob) {
      const fpNow = this.fingerprint(blob);
      const meta = this.readMeta();
      // Match by stable identity (accountUuid/email) so a token rotation isn't mistaken for a new
      // account; fall back to fingerprint for accounts saved before we snapshotted the profile.
      const known = this.matchByIdentity(meta, this.currentIdentity()) ?? meta.find(a => a.fingerprint === fpNow);
      if (known) {
        this.lastActiveName = known.name;
        // Token rotated → refresh the stored credential so active-detection and switchTo stay valid.
        if (known.fingerprint !== fpNow) await this.refreshStoredCredential(known.name, blob, fpNow);
        return nothing;
      }
      const saved = await this.autoSaveIfNewLogin(); // genuinely new login → snapshot; never throws
      if (saved) this.lastActiveName = saved.name;
      return { autoSaved: saved, removed: null, switchedTo: null };
    }
    return nothing;
  }

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
    // The Keychain swap changes the token but not the profile Claude Code shows in `/status`.
    // Restore the saved oauthAccount so the label matches; clear it (forcing a refetch) when the
    // account predates snapshotting, rather than leaving the previous account's stale label.
    const saved = this.readMeta().find(a => a.name === name);
    this.applyOauthAccount(saved?.oauthAccount);
  }

  /** Forget a saved account (Keychain item + metadata). Safe if the item is already gone. */
  async removeAccount(name: string): Promise<void> {
    try { await this.exec(['delete-generic-password', '-s', STORE_SERVICE, '-a', name]); } catch { /* already gone */ }
    this.writeMeta(this.readMeta().filter(a => a.name !== name));
  }

  /** All saved accounts, flagging the one that matches the current login. Identity (accountUuid/email
   *  from ~/.claude.json) is the primary signal so a rotated OAuth token doesn't hide the active
   *  account; the credential-blob fingerprint is only a fallback when no identity is available. */
  async listAccounts(): Promise<AccountView[]> {
    const meta = this.readMeta();
    const id = this.currentIdentity();
    const activeByIdentity = (id.uuid || id.email) ? this.matchByIdentity(meta, id) : undefined;
    let activeFp: string | null = null;
    if (!activeByIdentity) {
      try { const blob = await this.readCanonicalBlob(); activeFp = blob ? this.fingerprint(blob) : null; }
      catch { activeFp = null; }
    }
    return meta.map(a => ({
      name: a.name,
      email: a.email,
      displayName: a.displayName,
      organizationName: a.organizationName,
      savedAt: a.savedAt,
      active: activeByIdentity ? a.name === activeByIdentity.name : (activeFp !== null && a.fingerprint === activeFp),
    }));
  }
}
