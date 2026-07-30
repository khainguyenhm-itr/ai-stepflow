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
    const entry: AccountMeta = matchedByFingerprint
      ? {
          name: finalName,
          email: matchedByFingerprint.email,
          displayName: matchedByFingerprint.displayName,
          organizationName: matchedByFingerprint.organizationName,
          fingerprint: fp,
          savedAt: this.now(),
        }
      : {
          name: finalName,
          email: label?.email ?? finalName,
          displayName: label?.displayName,
          organizationName: label?.organizationName,
          fingerprint: fp,
          savedAt: this.now(),
        };
    this.writeMeta([...meta.filter(a => a.name !== finalName), entry]);
    return { ...entry, active: true };
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
  }

  /** Forget a saved account (Keychain item + metadata). Safe if the item is already gone. */
  async removeAccount(name: string): Promise<void> {
    try { await this.exec(['delete-generic-password', '-s', STORE_SERVICE, '-a', name]); } catch { /* already gone */ }
    this.writeMeta(this.readMeta().filter(a => a.name !== name));
  }

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
}
