import * as vscode from 'vscode';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigManager } from './configManager.js';
import { StateManager } from './stateManager.js';
import { reconnectRemoteMcpServer, findMcpConfigFile } from './mcp.js';
import type { McpServer } from './mcp.js';
import { setMcpServerEnabled, mcpLogout } from './mcpToggle.js';
import { installPlugin, updatePlugin, uninstallPlugin, pluginDetails } from './plugins.js';

/** GitNexus index + group state for the current project (read cheaply from ~/.gitnexus). */
export interface GitnexusStatus {
  indexed: boolean;
  stale: boolean;
  files: number;
  indexedAt: string | null;
  registryName: string | null;
  groups: string[];
  currentGroup: string | null;
  currentAlias: string | null;
}

/**
 * Encapsulates sidebar action methods (plugin tasks, MCP details, GitNexus commands, run deletion).
 * Constructed with references back to the provider's managers and refresh callback.
 */
export class SidebarActions {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly stateManager: StateManager,
    private readonly refresh: (probeMcp: boolean) => Promise<void>,
    private readonly getView: () => vscode.WebviewView | undefined,
    private readonly getCachedMcp: () => McpServer[]
  ) {}

  /** Install, update, or uninstall a plugin with a progress notification, then re-probe the catalog. */
  async runPluginTask(pluginId: string, pluginName: string | undefined, action: 'install' | 'update' | 'uninstall'): Promise<void> {
    const label = pluginName || pluginId;
    if (action === 'uninstall') {
      const choice = await vscode.window.showWarningMessage(
        `Uninstall plugin '${label}'?`,
        { modal: true, detail: 'Its data directory is preserved, so reinstalling keeps your config and history.' },
        'Uninstall'
      );
      if (choice !== 'Uninstall') return;
    }
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `${action === 'install' ? 'Installing' : action === 'update' ? 'Updating' : 'Uninstalling'} plugin '${label}'…`,
      cancellable: false
    }, async () => {
      const res = action === 'install' ? await installPlugin(pluginId) : action === 'update' ? await updatePlugin(pluginId) : await uninstallPlugin(pluginId);
      if (res.ok) {
        vscode.window.showInformationMessage(`ClaudeSteps: plugin '${label}' ${action === 'install' ? 'installed' : action === 'update' ? 'updated' : 'uninstalled'}.`);
      } else {
        vscode.window.showErrorMessage(`ClaudeSteps: failed to ${action} plugin. ${res.error}`);
      }
      await this.refresh(true);
    });
  }

  async showPluginDetails(pluginId: string, pluginName: string | undefined): Promise<void> {
    const label = pluginName || pluginId;
    const res = await pluginDetails(pluginId);
    if (!res.ok) {
      vscode.window.showErrorMessage(`ClaudeSteps: unable to load details for '${label}'. ${res.error}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      language: 'plaintext',
      content: res.output || `No details returned for ${label}.`
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async showMcpDetails(name: string): Promise<void> {
    const server = this.getCachedMcp().find(s => s.name === name);
    if (!server) {
      vscode.window.showWarningMessage(`ClaudeSteps: MCP server '${name}' is no longer in the current list.`);
      return;
    }
    const cwd = this.configManager.getProjectPath();
    const configFile = findMcpConfigFile(name, cwd) ?? '(not found in local or global config)';
    const content = [
      `Name:        ${server.name}`,
      `Status:      ${server.status}`,
      `Target:      ${server.target || '(not reported)'}`,
      `Config file: ${configFile}`,
      '',
      'Source: claude mcp list'
    ].join('\n');
    const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /**
   * Park an MCP server (enable=false) or bring it back (enable=true). Scope is the server's own:
   * a user-scope server goes quiet in every project, a local-scope one only in this workspace.
   * Credentials are untouched, so re-enabling an authenticated server reconnects without a re-login.
   */
  async setMcpEnabled(name: string, enable: boolean): Promise<void> {
    const cwd = this.configManager.getProjectPath();
    const res = setMcpServerEnabled(name, enable, cwd);
    if (res.ok) {
      const reach = res.scope === 'user' ? 'all projects' : 'this project';
      vscode.window.showInformationMessage(
        `ClaudeSteps: MCP server '${name}' ${enable ? 'enabled' : `disabled for ${reach}`}.`
      );
    } else {
      vscode.window.showErrorMessage(`ClaudeSteps: failed to ${enable ? 'enable' : 'disable'} '${name}'. ${res.error}`);
    }
    await this.refresh(true);
  }

  /** Clear the server's stored credentials so it returns to the signed-out ("needs auth") state. */
  async signOutMcp(name: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `Sign out of MCP server '${name}'?`,
      { modal: true, detail: 'Its stored credentials are cleared. The server stays configured, but you must authenticate again before it can connect.' },
      'Sign out'
    );
    if (choice !== 'Sign out') return;
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Signing out of MCP server '${name}'…`,
      cancellable: false
    }, async () => {
      const res = await mcpLogout(name, this.configManager.getProjectPath());
      if (res.ok) {
        vscode.window.showInformationMessage(`ClaudeSteps: signed out of '${name}'.`);
      } else {
        vscode.window.showErrorMessage(`ClaudeSteps: failed to sign out of '${name}'. ${res.error}`);
      }
      await this.refresh(true);
    });
  }

  /** Retry a failed remote MCP server from the sidebar using its current target. */
  async reconnectMcp(name: string, target: string): Promise<void> {
    // Plugin-managed and claude.ai servers are not managed via `claude mcp add/remove`
    if (name.startsWith('plugin:') || name.startsWith('claude.ai ')) {
      vscode.window.showInformationMessage(
        `'${name}' is managed by Claude Code plugins. To fix it, authenticate or reinstall the plugin from the Plugins tab.`
      );
      return;
    }
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Reconnecting MCP server '${name}'…`,
      cancellable: false
    }, async () => {
      const res = await reconnectRemoteMcpServer({ name, target, scope: 'user', cwd: this.configManager.getProjectPath() });
      if (res.ok) {
        vscode.window.showInformationMessage(`ClaudeSteps: MCP server '${name}' reconnected.`);
      } else {
        vscode.window.showErrorMessage(`ClaudeSteps: failed to reconnect MCP server. ${res.error}`);
      }
      await this.refresh(true);
    });
  }

  /**
   * Reads the GitNexus index state for the current project from the global registry
   * (`~/.gitnexus/registry.json`) — a cheap file read, no CLI cold start. Compares the
   * indexed commit against the working tree's HEAD to flag a stale (out-of-date) index.
   */
  async readGitnexusStatus(): Promise<GitnexusStatus> {
    const none: GitnexusStatus = { indexed: false, stale: false, files: 0, indexedAt: null, registryName: null, groups: [], currentGroup: null, currentAlias: null };
    const projectPath = this.configManager.getProjectPath();
    if (!projectPath) return none;
    let registry: Array<{ path?: string; name?: string; indexedAt?: string; lastCommit?: string; stats?: { files?: number } }>;
    try {
      registry = JSON.parse(readFileSync(join(homedir(), '.gitnexus', 'registry.json'), 'utf8'));
    } catch {
      return none; // registry missing/unreadable → treat as never indexed
    }
    const entry = Array.isArray(registry) ? registry.find(r => r.path === projectPath) : undefined;
    // Groups exist independently of whether this repo is indexed, so always read them.
    const registryName = entry?.name ?? null;
    const { groups, currentGroup, currentAlias } = this.readGitnexusGroups(registryName);
    if (!entry) return { ...none, groups, currentGroup, currentAlias };

    // Stale if the repo has changed since it was indexed, in either of two ways. Non-code files
    // (docs, configs, etc.) are excluded so a docs-only change doesn't demand a re-index.
    //   (a) HEAD moved — new commits or a branch switch — and the diff touches code.
    //   (b) A code file was edited AFTER indexing (mtime > indexedAt). Keyed on the analyze
    //       timestamp, not merely "the tree is dirty", so a freshly-analyzed dirty tree is NOT
    //       wrongly flagged — only edits made after the last analyze count.
    const CODE_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|c|cpp|cc|h|hpp|cs|swift|kt|php|vue|svelte)$/i;
    let stale = false;
    try {
      const run = promisify(execFile);
      const head = await run('git', ['rev-parse', 'HEAD'], { cwd: projectPath }).then(r => r.stdout.trim()).catch(() => '');
      // (a) branch/commit drift. If the diff can't be computed (rebased/unreachable), treat as stale.
      if (entry.lastCommit && head && entry.lastCommit !== head) {
        const diff = await run('git', ['diff', '--name-only', entry.lastCommit, head], { cwd: projectPath })
          .then(r => ({ ok: true, out: r.stdout.trim() }))
          .catch(() => ({ ok: false, out: '' }));
        stale = diff.ok ? diff.out.split('\n').some(line => CODE_EXTS.test(line)) : true;
      }
      // (b) uncommitted code edited after the last analyze.
      const indexedMs = entry.indexedAt ? Date.parse(entry.indexedAt) : NaN;
      if (!stale && !Number.isNaN(indexedMs)) {
        const dirty = await run('git', ['status', '--porcelain'], { cwd: projectPath }).then(r => r.stdout.trim()).catch(() => '');
        const files = dirty.split('\n')
          .map(line => { const p = line.slice(3).trim(); const arrow = p.indexOf(' -> '); return arrow >= 0 ? p.slice(arrow + 4) : p; })
          .filter(f => f && CODE_EXTS.test(f));
        stale = files.some(f => {
          try { return statSync(join(projectPath, f)).mtimeMs > indexedMs; } catch { return false; }
        });
      }
    } catch { /* not a git repo / git missing → leave stale=false */ }

    return { indexed: true, stale, files: entry.stats?.files ?? 0, indexedAt: entry.indexedAt ?? null, registryName, groups, currentGroup, currentAlias };
  }

  /**
   * Lists GitNexus groups (dir names under `~/.gitnexus/groups/`) and finds which one this
   * repo belongs to by scanning each `group.yaml`'s `repos:` block for its registry name.
   * Lightweight line-parse — group.yaml is flat (`  alias: registryName`), so no YAML lib.
   */
  readGitnexusGroups(registryName: string | null): { groups: string[]; currentGroup: string | null; currentAlias: string | null } {
    const groupsDir = join(homedir(), '.gitnexus', 'groups');
    let names: string[];
    try {
      names = readdirSync(groupsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    } catch {
      return { groups: [], currentGroup: null, currentAlias: null };
    }
    let currentGroup: string | null = null, currentAlias: string | null = null;
    if (registryName) {
      for (const name of names) {
        try {
          const yaml = readFileSync(join(groupsDir, name, 'group.yaml'), 'utf8');
          const alias = this.findGroupAlias(yaml, registryName);
          if (alias) { currentGroup = name; currentAlias = alias; break; }
        } catch { /* unreadable group → skip */ }
      }
    }
    return { groups: names, currentGroup, currentAlias };
  }

  /** Returns the alias key mapping to `registryName` inside a group.yaml `repos:` block, else null. */
  findGroupAlias(yaml: string, registryName: string): string | null {
    const lines = yaml.split(/\r?\n/);
    let inRepos = false;
    for (const line of lines) {
      if (/^repos:\s*$/.test(line)) { inRepos = true; continue; }
      if (inRepos) {
        if (!/^\s/.test(line)) break; // dedent → end of repos block
        const m = line.match(/^\s+(.+?):\s*(.+?)\s*$/);
        if (m && m[2] === registryName) return m[1].trim();
      }
    }
    return null;
  }

  /** Opens a GitNexus state file (registry.json / group.yaml) in an editor; warns if missing. */
  async openGitnexusFile(filePath: string, missingHint: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch {
      vscode.window.showWarningMessage(`ClaudeSteps: GitNexus ${missingHint}`);
    }
  }

  /**
   * (Re)builds the GitNexus knowledge graph in the background with a progress notification — no
   * terminal to babysit or close. When `group` names a real group and the repo isn't indexed yet,
   * runs the combined analyze+join flow so the up-front group choice is applied in one pass.
   * The sidebar refreshes automatically the moment the run finishes, so the status is always real.
   */
  async runGitnexusAnalyze(group?: string): Promise<void> {
    this.getView()?.webview.postMessage({ type: 'gitnexusAnalyzeStarted' });
    let cmds: string[][] = [['analyze']];
    if (group && group !== 'default' && group !== '__create__') {
      const status = await this.readGitnexusStatus();
      if (!status.indexed) cmds = this.joinGroupCmds(group, status);
    }
    await this.runGitnexusCommandsBg(cmds, 'Analyzing repository with GitNexus…');
  }

  /**
   * Runs a sequence of `gitnexus` subcommands (each an arg array, e.g. `['analyze']`) via
   * `npx gitnexus …` in the project dir, under a single cancellable progress notification. No
   * terminal — the sidebar refreshes on completion/cancel/failure so status reflects reality
   * without the user having to close anything.
   */
  private async runGitnexusCommandsBg(argLists: string[][], title: string): Promise<void> {
    const cwd = this.configManager.getProjectPath() || undefined;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        async (_progress, token) => {
          for (const args of argLists) {
            if (token.isCancellationRequested) break;
            await new Promise<void>((resolve, reject) => {
              const child = execFile('npx', ['-y', 'gitnexus', ...args], { cwd, maxBuffer: 64 * 1024 * 1024 }, err => {
                if (err && !token.isCancellationRequested) reject(err); else resolve();
              });
              token.onCancellationRequested(() => child.kill());
            });
          }
        }
      );
    } catch (e) {
      vscode.window.showErrorMessage(`ClaudeSteps: GitNexus command failed. ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.refresh(false);
  }

  /**
   * Deletes the GitNexus index for the current repo (`gitnexus clean --force`) after a confirm
   * prompt, in the background. The sidebar refreshes on completion so the row flips back to "Analyze".
   */
  async runGitnexusClean(): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      'Remove the GitNexus index for this repo? You can re-analyze at any time.',
      { modal: true }, 'Remove'
    );
    if (ok !== 'Remove') return;
    await this.runGitnexusCommandsBg([['clean', '--force']], 'Removing GitNexus index…');
  }

  /** The registry name `gitnexus analyze` assigns to this repo — always `basename(projectPath)`. */
  deriveRegistryName(): string | null {
    const p = this.configManager.getProjectPath();
    return p ? basename(p) : null;
  }

  /**
   * Commands to put this repo into `group`: leave the old group if any, (re-)index, add here,
   * then sync so cross-repo contracts use a fresh index. `analyze` runs FIRST so the registry
   * entry exists before `group add` — `group add` takes a *registry name*, which only exists once
   * the repo has been analyzed at least once. Group membership does NOT change a repo's own index
   * (it's a mapping in group.yaml), so when the index is already fresh, pass `skipAnalyze` to skip
   * the redundant re-index — only `group add` + `group sync` (cross-repo contracts) need to run.
   */
  joinGroupCmds(group: string, status: GitnexusStatus, skipAnalyze = false): string[][] {
    const name = status.registryName ?? this.deriveRegistryName()!; // registry name == alias (flat)
    const cmds: string[][] = [];
    if (status.currentGroup && status.currentGroup !== group && status.currentAlias) {
      cmds.push(['group', 'remove', status.currentGroup, status.currentAlias]);
    }
    if (!skipAnalyze) cmds.push(['analyze']);     // (re-)index this repo; creates registry entry if new
    cmds.push(['group', 'add', group, name, name]);
    cmds.push(['group', 'sync', group]);          // rebuild cross-repo contracts
    return cmds;
  }

  /**
   * "＋ Create new group…": prompt a name, then create it AND join this repo in one flow
   * (create → analyze → add → sync), so there's no confusing empty-group middle state.
   * Works before the first analyze — the registry name is derived from the project path.
   */
  async createGitnexusGroup(): Promise<void> {
    const status = await this.readGitnexusStatus();
    const name = await vscode.window.showInputBox({
      title: 'Create GitNexus Group',
      prompt: 'New group name — this repo will be added to it',
      placeHolder: 'e.g. my-services',
      validateInput: v => {
        const t = v.trim();
        if (!/^[a-zA-Z0-9._-]+$/.test(t)) return 'Use letters, digits, dot, dash or underscore';
        if (status.groups.includes(t)) return 'A group with this name already exists — pick it from the list instead';
        return null;
      }
    });
    if (!name) return;
    // A fresh existing index needs no re-analyze — just create the group and wire this repo in.
    const fresh = status.indexed && !status.stale;
    if (!fresh) this.getView()?.webview.postMessage({ type: 'gitnexusAnalyzeStarted' });
    await this.runGitnexusCommandsBg([['group', 'create', name.trim()], ...this.joinGroupCmds(name.trim(), status, fresh)], `Creating group "${name.trim()}"…`);
  }

  /**
   * Joins/leaves a GitNexus group (chosen from the ··· menu; indexed repos only). Default → leave
   * the current group. A group → switch group, then sync. Joining/switching does NOT re-index a
   * repo whose index is already fresh (group membership is independent of the per-repo graph) —
   * a re-analyze runs only when the index is missing or stale. Posts `gitnexusStatus` back to
   * clear the transient state when the user cancels.
   */
  async selectGitnexusGroup(group: string): Promise<void> {
    const status = await this.readGitnexusStatus();

    if (group === 'default') {
      if (!status.currentGroup || !status.currentAlias) return;
      const choice = await vscode.window.showWarningMessage(
        `Leave group "${status.currentGroup}"?`,
        { modal: true },
        'Leave'
      );
      if (choice !== 'Leave') {
        this.getView()?.webview.postMessage({ type: 'gitnexusStatus', status });
        return;
      }
      await this.runGitnexusCommandsBg([['group', 'remove', status.currentGroup, status.currentAlias]], `Leaving group "${status.currentGroup}"…`);
      return;
    }

    const fresh = status.indexed && !status.stale;
    const choice = await vscode.window.showInformationMessage(
      fresh
        ? `Switch to group "${group}"? The index is up to date — no re-analyze needed.`
        : `Switch to group "${group}"? This will re-analyze the repo (may take a moment).`,
      { modal: true },
      'Switch'
    );
    if (choice !== 'Switch') {
      this.getView()?.webview.postMessage({ type: 'gitnexusStatus', status });
      return;
    }
    if (!fresh) this.getView()?.webview.postMessage({ type: 'gitnexusAnalyzeStarted' });
    await this.runGitnexusCommandsBg(
      this.joinGroupCmds(group, status, fresh),
      fresh ? `Switching to group "${group}"…` : `Re-analyzing & switching to "${group}"…`
    );
  }

  /** Deletes a run file, its report, and audit log entries after confirmation. */
  async deleteRun(filePath: string): Promise<void> {
    const name = filePath.split(/[\\/]/).pop() || filePath;
    const choice = await vscode.window.showWarningMessage(
      `Delete run "${name}" and its report?`,
      { modal: true },
      'Delete'
    );
    if (choice !== 'Delete') return;

    try {
      // Parse flowId/runId from filename: {safe(flowId)}-{safe(runId)}.json
      const stem = name.replace(/\.json$/, '');
      void stem; // used for documentation only; actual IDs read from file content
      // Run files are saved as {safe(flowId)}-{safe(runId)}.json; we can derive IDs from the
      // JSON content to be safe rather than reverse-parsing the filename.
      const { promises: fsP } = await import('fs');
      try {
        const raw = JSON.parse(await fsP.readFile(filePath, 'utf8'));
        await Promise.all([
          this.stateManager.clearAuditLog(raw.flowId, raw.runId),
          this.stateManager.deleteReportFile(raw),
        ]);
      } catch { /* best-effort: continue to delete the run file */ }
      await vscode.workspace.fs.delete(vscode.Uri.file(filePath));
    } catch (e) {
      vscode.window.showErrorMessage(`ClaudeSteps: unable to delete run. ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.refresh(false);
  }
}
