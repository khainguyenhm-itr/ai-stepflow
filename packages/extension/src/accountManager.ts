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
