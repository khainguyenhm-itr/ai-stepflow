import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigManager } from './configManager.js';
import type { BundledKind } from './configManager.js';
import { StateManager } from './stateManager.js';
import { listMcpServers, reconnectRemoteMcpServer, findMcpConfigFile } from './mcp.js';
import type { McpServer } from './mcp.js';
import { listPluginCatalog, togglePlugin, installPlugin, updatePlugin, uninstallPlugin, pluginDetails } from './plugins.js';
import type { PluginInfo, AvailablePlugin } from './plugins.js';

/** GitNexus index + group state for the current project (read cheaply from ~/.gitnexus). */
interface GitnexusStatus {
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
 * Renders the activity-bar sidebar as a compact dashboard: the active run, library
 * counts, connected MCP servers, Claude plugins, and the run files this extension generated.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ai-stepflow-home';
  private _view?: vscode.WebviewView;
  /** Last MCP probe result, reused on cheap refreshes so we don't respawn the CLI. */
  private _cachedMcp: McpServer[] = [];
  /** Last plugin probe result, reused on cheap refreshes so we don't respawn the CLI. */
  private _cachedPlugins: PluginInfo[] = [];
  private _cachedAvailable: AvailablePlugin[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private configManager: ConfigManager,
    private stateManager: StateManager,
    private readonly version: string
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    try {
      this._view = view;
      view.webview.options = {
        enableScripts: true,
        localResourceRoots: [this.extensionUri]
      };
      view.webview.html = this._getHtml(view.webview);

      view.webview.onDidReceiveMessage(async (message: { type?: string; path?: string; url?: string; pluginId?: string; pluginName?: string; enable?: boolean; mcpName?: string; mcpTarget?: string; tab?: string; kind?: BundledKind; filename?: string; isGlobal?: boolean; flowId?: string; runId?: string; group?: string; }) => {
        try {
          switch (message?.type) {
            case 'openRun':
              if (message.flowId && message.runId) {
                await vscode.commands.executeCommand('ai-stepflow.openRun', message.flowId, message.runId);
              } else {
                await vscode.commands.executeCommand('ai-stepflow.openOverview');
              }
              return;
            case 'openOverview':
              if (message.tab) {
                await vscode.commands.executeCommand('ai-stepflow.openTab', message.tab);
              } else {
                await vscode.commands.executeCommand('ai-stepflow.openOverview');
              }
              return;
            case 'refresh':
              await this.configManager.ensureProjectClaudeMd();
              await this.refresh(true);
              return;
            case 'openFile':
              if (message.path) {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(message.path));
                await vscode.window.showTextDocument(doc, { preview: true });
              }
              return;
            case 'deleteRun':
              if (message.path) await this._deleteRun(message.path);
              return;
            case 'installDefaults':
              await vscode.commands.executeCommand('ai-stepflow.installDefaults');
              return;
            case 'installDefaultItem':
              if (message.kind && message.filename) {
                await this.configManager.installBundledItem(message.kind, message.filename, message.isGlobal !== false);
                if (message.isGlobal !== false) await this.configManager.ensureGlobalClaudeMd();
                await this.refresh(false);
              }
              return;
            case 'uninstallDefaultItem':
              if (message.kind && message.filename) {
                await this.configManager.uninstallBundledItem(message.kind, message.filename);
                await this.refresh(false);
              }
              return;
            case 'updateDefaultItem':
              if (message.kind && message.filename) {
                await this.configManager.installBundledItem(message.kind, message.filename, message.isGlobal !== false);
                await this.refresh(false);
              }
              return;
            case 'openExternal':
              if (message.url) await vscode.env.openExternal(vscode.Uri.parse(message.url));
              return;
            case 'pluginDetails':
              if (message.pluginId) await this._showPluginDetails(message.pluginId, message.pluginName);
              return;
            case 'togglePlugin':
              if (message.pluginId && typeof message.enable === 'boolean') {
                const label = message.pluginName || message.pluginId;
                const res = await togglePlugin(message.pluginId, message.enable);
                if (res.ok) {
                  vscode.window.showInformationMessage(`AI StepFlow: plugin '${label}' ${message.enable ? 'enabled' : 'disabled'}.`);
                } else {
                  vscode.window.showErrorMessage(`AI StepFlow: failed to toggle plugin. ${res.error}`);
                }
                await this.refresh(true);
              }
              return;
            case 'installPlugin':
              if (message.pluginId) await this._runPluginTask(message.pluginId, message.pluginName, 'install');
              return;
            case 'updatePlugin':
              if (message.pluginId) await this._runPluginTask(message.pluginId, message.pluginName, 'update');
              return;
            case 'uninstallPlugin':
              if (message.pluginId) await this._runPluginTask(message.pluginId, message.pluginName, 'uninstall');
              return;
            case 'savePref':
              if ((message as any).key && (message as any).value !== undefined) {
                if ((message as any).key === 'ai:responseStyle') {
                  await this.configManager.saveGlobalUiPref((message as any).key, (message as any).value);
                  await this.configManager.applyResponseStyle((message as any).value);
                } else {
                  await this.configManager.saveUiPref((message as any).key, (message as any).value);
                }
              }
              return;
            case 'reconnectMcp':
              if (message.mcpName && message.mcpTarget) await this._reconnectMcp(message.mcpName, message.mcpTarget);
              return;
            case 'mcpDetails':
              if (message.mcpName) await this._showMcpDetails(message.mcpName);
              return;
            case 'astScan':
              await vscode.commands.executeCommand('ai-stepflow.astGraph.rescan');
              await this.refresh(true);
              return;
            case 'astRegister':
              await vscode.commands.executeCommand('ai-stepflow.astGraph.reregisterMcp');
              await this.refresh(true);
              return;
            case 'openAstSettings':
              await vscode.commands.executeCommand('workbench.action.openSettings', 'ai-stepflow.astGraph');
              return;
            case 'gitnexusAnalyze':
              await this._runGitnexusAnalyze(message.group);
              return;
            case 'gitnexusCreateGroup':
              await this._createGitnexusGroup();
              return;
            case 'gitnexusSelectGroup':
              if (message.group) await this._selectGitnexusGroup(message.group);
              return;
            case 'gitnexusOpenRegistry':
              await this._openGitnexusFile(join(homedir(), '.gitnexus', 'registry.json'), 'registry not found yet — run Analyze first.');
              return;
            case 'gitnexusOpenGroup': {
              const st = await this._readGitnexusStatus();
              if (st.currentGroup) await this._openGitnexusFile(join(homedir(), '.gitnexus', 'groups', st.currentGroup, 'group.yaml'), 'group config not found.');
              return;
            }
          }
        } catch (e) {
          vscode.window.showErrorMessage(`AI StepFlow: ${e instanceof Error ? e.message : String(e)}`);
        }
      });

      // Repaint when the view is revealed; re-probe MCP if any server was last seen as failed.
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          const hasFailed = this._cachedMcp.some(s => s.status === 'failed' || s.status === 'unknown');
          void this.refresh(hasFailed);
        }
      });
      void this.refresh(true);
    } catch (e) {
      console.error('AI StepFlow: failed to resolve sidebar view', e);
    }
  }

  /** Re-gathers data and pushes it to the webview. Set probeMcp to respawn the CLI. */
  public async refresh(probeMcp: boolean): Promise<void> {
    if (!this._view) return;

    try {
      const [flows, agents, skills, runFiles, activeRun, defaultItems, uiPrefs, gitnexus] = await Promise.all([
        this.configManager.loadFlows().catch(() => []),
        this.configManager.loadAgents().catch(() => []),
        this.configManager.loadSkills().catch(() => []),
        this.stateManager.listRunFiles().catch(() => []),
        this.stateManager.loadLatestRun().catch(() => undefined),
        this.configManager.listBundledDefaults().catch(() => []),
        this.configManager.loadUiPrefs().catch(() => ({} as Record<string, string>)),
        this._readGitnexusStatus().catch(() => ({ indexed: false, stale: false, files: 0, indexedAt: null, registryName: null, groups: [], currentGroup: null, currentAlias: null } as GitnexusStatus))
      ]);
      const flowName = (id: string) => flows.find(f => f.id === id)?.name || id;
      const visibleRunFiles = runFiles.filter(file => !file.isClosed);

      // Collect every agent/skill name referenced by any flow step (used for in-use guard).
      const usedAgents = new Set<string>();
      const usedSkills = new Set<string>();
      for (const flow of flows) {
        for (const step of flow.steps ?? []) {
          if (step.agent) usedAgents.add(step.agent);
          if (step.skill) usedSkills.add(step.skill);
          for (const s of step.skills ?? []) usedSkills.add(s);
          for (const r of step.review?.reviewers ?? []) {
            if (r.agent) usedAgents.add(r.agent);
            if (r.skill) usedSkills.add(r.skill);
          }
        }
      }
      const annotatedItems = defaultItems.map(item => ({
        ...item,
        inUse: item.kind === 'agents' ? usedAgents.has(item.name) : item.kind === 'skills' ? usedSkills.has(item.name) : false
      }));

      let active: any = null;
      if (activeRun) {
        const flow = flows.find(f => f.id === activeRun.flowId);
        const total = flow?.steps.length ?? Object.keys(activeRun.steps || {}).length;
        const completed = Object.values(activeRun.steps || {}).filter((s: any) => s.completionStatus === 'done').length;
        // The running step, else the first step not yet done.
        const currentStep = flow?.steps.find(step => activeRun.steps[step.id]?.executionStatus === 'running')
          ?? flow?.steps.find(step => activeRun.steps[step.id]?.completionStatus !== 'done');
        const activeRunFile = visibleRunFiles.find(f => f.runId === activeRun.runId);
        const stepStatus = currentStep ? (activeRun.steps[currentStep.id]?.executionStatus || 'ready') : null;
        active = {
          flowName: flowName(activeRun.flowId),
          runId: activeRun.runId,
          runName: activeRun.runName,
          completed,
          total,
          percent: total ? Math.round((completed / total) * 100) : 0,
          filePath: activeRunFile?.filePath ?? null,
          isRunning: stepStatus === 'running',
          currentStep: currentStep
            ? { title: currentStep.title || currentStep.id, status: stepStatus }
            : null
        };
      }

      this._view.webview.postMessage({
        type: 'data',
        stats: { flows: flows.length, agents: agents.length, skills: skills.length },
        defaultItems: annotatedItems,
        uiPrefs,
        gitnexus,
        mcp: this._cachedMcp,
        plugins: this._cachedPlugins,
        pluginsAvailable: this._cachedAvailable,
        runFiles: visibleRunFiles.map(file => ({
          flowId: file.flowId,
          flowName: flowName(file.flowId),
          runId: file.runId,
          runName: file.runName,
          completed: file.completedSteps,
          total: file.totalSteps,
          filePath: file.filePath,
          isClosed: file.isClosed,
          isActive: file.runId === activeRun?.runId
        })),
        totalRunFiles: visibleRunFiles.length
      });

      if (probeMcp) {
        // Both probes spawn the `claude` CLI (slow cold start), so keep them off the
        // critical path: the dashboard paints immediately, then each result is pushed in.
        void listMcpServers(this.configManager.getProjectPath()).then(mcp => {
          this._cachedMcp = mcp;
          this._view?.webview.postMessage({ type: 'mcp', mcp });
        }).catch(err => {
          console.error('AI StepFlow: MCP probe failed', err);
        });
        void listPluginCatalog().then(({ installed, available }) => {
          this._cachedPlugins = installed;
          this._cachedAvailable = available;
          this._view?.webview.postMessage({ type: 'plugins', plugins: installed, pluginsAvailable: available });
        }).catch(err => {
          console.error('AI StepFlow: plugin probe failed', err);
        });
      }
    } catch (e) {
      console.error('AI StepFlow: sidebar refresh failed', e);
      if (this._view) {
        this._view.webview.postMessage({
          type: 'data',
          stats: { flows: 0, agents: 0, skills: 0 },
          defaultItems: [],
          activeRun: null,
          mcp: [],
          plugins: [],
          pluginsAvailable: [],
          runFiles: [],
          totalRunFiles: 0
        });
      }
    }
  }

  /** Install, update, or uninstall a plugin with a progress notification, then re-probe the catalog. */
  private async _runPluginTask(pluginId: string, pluginName: string | undefined, action: 'install' | 'update' | 'uninstall'): Promise<void> {
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
        vscode.window.showInformationMessage(`AI StepFlow: plugin '${label}' ${action === 'install' ? 'installed' : action === 'update' ? 'updated' : 'uninstalled'}.`);
      } else {
        vscode.window.showErrorMessage(`AI StepFlow: failed to ${action} plugin. ${res.error}`);
      }
      await this.refresh(true);
    });
  }

  private async _showPluginDetails(pluginId: string, pluginName: string | undefined): Promise<void> {
    const label = pluginName || pluginId;
    const res = await pluginDetails(pluginId);
    if (!res.ok) {
      vscode.window.showErrorMessage(`AI StepFlow: unable to load details for '${label}'. ${res.error}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      language: 'plaintext',
      content: res.output || `No details returned for ${label}.`
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private async _showMcpDetails(name: string): Promise<void> {
    const server = this._cachedMcp.find(s => s.name === name);
    if (!server) {
      vscode.window.showWarningMessage(`AI StepFlow: MCP server '${name}' is no longer in the current list.`);
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

  /** Retry a failed remote MCP server from the sidebar using its current target. */
  private async _reconnectMcp(name: string, target: string): Promise<void> {
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
        vscode.window.showInformationMessage(`AI StepFlow: MCP server '${name}' reconnected.`);
      } else {
        vscode.window.showErrorMessage(`AI StepFlow: failed to reconnect MCP server. ${res.error}`);
      }
      await this.refresh(true);
    });
  }

  /**
   * Reads the GitNexus index state for the current project from the global registry
   * (`~/.gitnexus/registry.json`) — a cheap file read, no CLI cold start. Compares the
   * indexed commit against the working tree's HEAD to flag a stale (out-of-date) index.
   */
  private async _readGitnexusStatus(): Promise<GitnexusStatus> {
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
    const { groups, currentGroup, currentAlias } = this._readGitnexusGroups(registryName);
    if (!entry) return { ...none, groups, currentGroup, currentAlias };

    // Stale if HEAD moved past the indexed commit, or the working tree has uncommitted changes.
    let stale = false;
    try {
      const run = promisify(execFile);
      const [head, dirty] = await Promise.all([
        run('git', ['rev-parse', 'HEAD'], { cwd: projectPath }).then(r => r.stdout.trim()).catch(() => ''),
        run('git', ['status', '--porcelain'], { cwd: projectPath }).then(r => r.stdout.trim()).catch(() => '')
      ]);
      stale = (!!entry.lastCommit && !!head && entry.lastCommit !== head) || dirty.length > 0;
    } catch { /* not a git repo / git missing → leave stale=false */ }

    return { indexed: true, stale, files: entry.stats?.files ?? 0, indexedAt: entry.indexedAt ?? null, registryName, groups, currentGroup, currentAlias };
  }

  /**
   * Lists GitNexus groups (dir names under `~/.gitnexus/groups/`) and finds which one this
   * repo belongs to by scanning each `group.yaml`'s `repos:` block for its registry name.
   * Lightweight line-parse — group.yaml is flat (`  alias: registryName`), so no YAML lib.
   */
  private _readGitnexusGroups(registryName: string | null): { groups: string[]; currentGroup: string | null; currentAlias: string | null } {
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
          const alias = this._findGroupAlias(yaml, registryName);
          if (alias) { currentGroup = name; currentAlias = alias; break; }
        } catch { /* unreadable group → skip */ }
      }
    }
    return { groups: names, currentGroup, currentAlias };
  }

  /** Returns the alias key mapping to `registryName` inside a group.yaml `repos:` block, else null. */
  private _findGroupAlias(yaml: string, registryName: string): string | null {
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
  private async _openGitnexusFile(filePath: string, missingHint: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch {
      vscode.window.showWarningMessage(`AI StepFlow: GitNexus ${missingHint}`);
    }
  }

  /**
   * (Re)builds the GitNexus knowledge graph in a terminal. When `group` names a real group and
   * the repo isn't indexed yet, runs the combined analyze+join flow so the user's up-front group
   * choice is applied in one pass (no separate re-analyze). Otherwise a plain analyze.
   */
  private async _runGitnexusAnalyze(group?: string): Promise<void> {
    if (group && group !== 'default' && group !== '__create__') {
      const status = await this._readGitnexusStatus();
      if (!status.indexed) {
        this._runGroupTerminal(this._joinGroupCmds(group, status));
        this._view?.webview.postMessage({ type: 'gitnexusAnalyzeStarted' });
        return;
      }
    }
    const cwd = this.configManager.getProjectPath();
    const terminal = vscode.window.createTerminal({ name: 'GitNexus Analyze', cwd: cwd || undefined });
    terminal.show();
    terminal.sendText('gitnexus analyze', true);
    // The terminal runs detached; reset the sidebar button so it's clickable again.
    this._view?.webview.postMessage({ type: 'gitnexusAnalyzeStarted' });
  }

  /** The registry name `gitnexus analyze` assigns to this repo — always `basename(projectPath)`. */
  private _deriveRegistryName(): string | null {
    const p = this.configManager.getProjectPath();
    return p ? basename(p) : null;
  }

  /**
   * Commands to put this repo into `group`: leave the old group if any, (re-)index, add here,
   * then sync so cross-repo contracts use a fresh index. `analyze` runs FIRST so the registry
   * entry exists before `group add` — this lets the user pick a group before the first analyze.
   */
  private _joinGroupCmds(group: string, status: GitnexusStatus): string[] {
    const name = status.registryName ?? this._deriveRegistryName()!; // registry name == alias (flat)
    const cmds: string[] = [];
    if (status.currentGroup && status.currentGroup !== group && status.currentAlias) {
      cmds.push(`gitnexus group remove ${status.currentGroup} ${status.currentAlias}`);
    }
    cmds.push('gitnexus analyze');             // (re-)index this repo; creates registry entry if new
    cmds.push(`gitnexus group add ${group} ${name} ${name}`);
    cmds.push(`gitnexus group sync ${group}`); // rebuild cross-repo contracts
    return cmds;
  }

  private _runGroupTerminal(cmds: string[]): void {
    const cwd = this.configManager.getProjectPath();
    const terminal = vscode.window.createTerminal({ name: 'GitNexus Group', cwd: cwd || undefined });
    terminal.show();
    terminal.sendText(cmds.join(' && '), true);
  }

  /**
   * "＋ Create new group…": prompt a name, then create it AND join this repo in one flow
   * (create → analyze → add → sync), so there's no confusing empty-group middle state.
   * Works before the first analyze — the registry name is derived from the project path.
   */
  private async _createGitnexusGroup(): Promise<void> {
    const status = await this._readGitnexusStatus();
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
    this._runGroupTerminal([`gitnexus group create ${name.trim()}`, ...this._joinGroupCmds(name.trim(), status)]);
  }

  /**
   * Joins/leaves a GitNexus group from the select (indexed repos only — before the first analyze
   * the select is a pending choice applied by the Analyze button, not run here).
   * Default → leave the current group. A group → switch group, then re-index + sync.
   */
  private async _selectGitnexusGroup(group: string): Promise<void> {
    const status = await this._readGitnexusStatus();

    if (group === 'default') {
      if (status.currentGroup && status.currentAlias) {
        this._runGroupTerminal([`gitnexus group remove ${status.currentGroup} ${status.currentAlias}`]);
      }
      await this.refresh(false);
      return;
    }

    this._runGroupTerminal(this._joinGroupCmds(group, status));
  }

  /** Deletes a run file, its report, and audit log entries after confirmation. */
  private async _deleteRun(filePath: string): Promise<void> {
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
      vscode.window.showErrorMessage(`AI StepFlow: unable to delete run. ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.refresh(false);
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --r: 3px;
      --r-sm: 2px;
      --border: var(--vscode-panel-border, #3c3c3c);
      --panel: var(--vscode-sideBar-background, #252526);
      --panel-2: var(--vscode-editorWidget-background, #2d2d2d);
      --hover: var(--vscode-list-hoverBackground, #2a2d2e);
      --focus: var(--vscode-focusBorder, #007fd4);
      --btn: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #fff);
      --btn-h: var(--vscode-button-hoverBackground, #1177bb);
      --error: var(--vscode-errorForeground, #f48771);
      --badge: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #fff);
      --muted: var(--vscode-descriptionForeground, #9d9d9d);
      --success: var(--vscode-charts-green, #73c991);
      --fg: var(--vscode-foreground, #cccccc);
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; margin: 0; padding: 0; }
    body { color: var(--fg); background: var(--panel); font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); font-size: var(--vscode-font-size, 13px); line-height: 1.4; }
    button { font-family: inherit; cursor: pointer; }

    /* ── shell layout ── */
    .shell { display: flex; flex-direction: column; height: 100vh; }

    /* header row */
    .hdr { display: flex; align-items: center; gap: 7px; padding: 10px 12px 0; flex: 0 0 auto; }
    .mark { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: var(--r); background: var(--btn); color: var(--btn-fg); font-size: 9px; font-weight: 700; flex: 0 0 auto; letter-spacing: .02em; }
    .brand-name { flex: 1; font-size: 12.5px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ver { color: var(--muted); font-size: 10px; flex: 0 0 auto; }
    .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--muted); font-size: 13px; line-height: 1; }
    .icon-btn:hover { color: var(--fg); background: var(--hover); }

    /* scrollable content area — flex column so expanded accordion section can grow */
    .body { flex: 1 1 0; overflow: hidden; display: flex; flex-direction: column; padding: 0 12px 8px; }

    /* ── accordion: expanded section fills remaining sidebar height ── */
    .sec.expanded { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
    .sec.expanded > .sec-hdr { flex: 0 0 auto; }
    .sec.expanded > .box { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    .sec.expanded > .box > .box-tabs,
    .sec.expanded > .box > .box-search { flex: 0 0 auto; }
    .sec.expanded > .box > #mcp,
    .sec.expanded > .box > #plugins,
    .sec.expanded > .box > #runs { flex: 1; min-height: 0; overflow-y: auto; max-height: none; scrollbar-width: none; }
    .sec.expanded > .box > #mcp::-webkit-scrollbar,
    .sec.expanded > .box > #plugins::-webkit-scrollbar,
    .sec.expanded > .box > #runs::-webkit-scrollbar { display: none; }
    /* Default Library expanded */
    .sec.expanded > #defaults-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .sec.expanded .lib-panel { flex: 1; min-height: 0; max-height: none; overflow-y: auto; }

    /* ── run cards ── */
    #runs { padding: 4px 6px; display: flex; flex-direction: column; gap: 6px; }
    .run-card { padding: 8px 10px 8px 13px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel); cursor: default; transition: border-color .15s, background .15s; position: relative; }
    .run-card::before { content: ''; position: absolute; left: 0; top: 4px; bottom: 4px; width: 3px; border-radius: 0 2px 2px 0; background: var(--border); }
    .run-card:hover { border-color: var(--focus); background: var(--hover); }
    .run-card.run-active::before { background: var(--btn); }
    .run-card.run-done::before { background: var(--success); }
    .run-card.run-done:hover { border-color: var(--success); }
    .run-card-head { display: flex; align-items: flex-start; gap: 5px; min-width: 0; }
    .run-card-titles { flex: 1; min-width: 0; overflow: hidden; }
    .run-card-title { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); line-height: 1.3; }
    .run-card-sub { font-size: 10px; color: var(--muted); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-card-bar { height: 3px; border-radius: 2px; background: rgba(127,127,127,.15); overflow: hidden; margin: 6px 0 5px; }
    .run-card-bar-fill { height: 100%; border-radius: 2px; background: var(--vscode-progressBar-background, #0e70c0); transition: width .3s ease; }
    .run-card.run-active .run-card-bar-fill { background: var(--btn); }
    .run-card.run-done .run-card-bar-fill { background: var(--success); }
    .run-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .run-card-meta { font-size: 10px; color: var(--muted); }
    .run-card-acts { flex-shrink: 0; opacity: 1; }
    .run-card:hover .run-card-acts, .run-card.run-active .run-card-acts { opacity: 1; }
    .run-sbadge { display: inline-flex; align-items: center; height: 14px; padding: 0 5px; border-radius: 9px; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; white-space: nowrap; flex-shrink: 0; margin-top: 1px; }
    .run-sbadge.running { background: var(--vscode-charts-blue, var(--focus)); color: #fff; }
    .run-sbadge.done { background: var(--success); color: #fff; }
    .run-sbadge.partial { background: rgba(215,160,0,.18); color: var(--vscode-charts-yellow, #d7ba7d); }
    .run-step-row { display: flex; align-items: center; gap: 4px; overflow: hidden; }
    .run-step-name { font-size: 10px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* badge */
    .badge { display: inline-flex; align-items: center; height: 16px; padding: 0 6px; border-radius: 9px; font-size: 9px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--badge-fg); background: var(--badge); white-space: nowrap; flex: 0 0 auto; }
    .badge.running { background: var(--vscode-charts-blue, var(--focus)); }
    .badge.completed { background: var(--success); }

    /* ── settings ── */
    .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; }
    .setting-row + .setting-row { border-top: 1px solid rgba(127,127,127,.07); }
    .setting-label { font-size: 11px; color: var(--fg); font-weight: 500; }
    .setting-desc { font-size: 10px; color: var(--muted); margin-top: 1px; }
    .gx-dot { display: none; width: 6px; height: 6px; border-radius: 50%; margin-right: 5px; vertical-align: middle; background: var(--muted); }
    /* GitNexus row stacks vertically: status line (with ··· menu) on top, controls on a second line. */
    .gx-row { flex-direction: column; align-items: stretch; gap: 8px; }
    .gx-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .gx-ctl { display: flex; align-items: center; gap: 6px; }

    /* ── section ── */
    .sec { margin-top: 8px; }
    .sec-hdr { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); overflow: hidden; }
    #lib-hdr { padding: 9px 8px; }
    .sec-label { flex: 1; font-size: 12px; font-weight: 700; color: var(--fg); }
    .sec-count { display: inline-flex; align-items: center; height: 15px; padding: 0 5px; border-radius: 9px; font-size: 9px; font-weight: 700; color: var(--badge-fg); background: var(--badge); }
    .sec-count:empty { display: none; }
    .sec-toggle { display: flex; align-items: center; gap: 7px; width: 100%; padding: 9px 8px; border: 0; background: transparent; color: inherit; text-align: left; font-family: inherit; transition: background .1s; }
    .sec-toggle:hover { background: var(--hover); }

    /* ── library stats ── */
    .stats { display: flex; gap: 5px; }
    .stat { flex: 1; min-width: 0; padding: 7px 8px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); cursor: pointer; text-align: center; transition: border-color .1s, background .1s; }
    .stat:hover { border-color: var(--focus); }
    .stat-num { font-size: 18px; font-weight: 700; line-height: 1.1; }
    .stat-lbl { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-top: 2px; }

    /* default library expandable */
    .lib-toggle { display: flex; align-items: center; gap: 7px; margin-top: 6px; padding: 9px 8px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); cursor: pointer; width: 100%; text-align: left; font-family: inherit; color: var(--fg); transition: background .1s; }
    .lib-toggle:hover { background: var(--hover); }
    .lib-caret { font-size: 9px; color: var(--muted); transition: transform .15s; flex: 0 0 auto; }
    .lib-caret.open { transform: rotate(90deg); }
    .lib-toggle-label { flex: 1; font-size: 12px; font-weight: 700; color: var(--fg); }
    .lib-toggle-badge { display: inline-flex; align-items: center; height: 15px; padding: 0 5px; border-radius: 9px; font-size: 9px; font-weight: 700; color: var(--badge-fg); background: var(--success); flex: 0 0 auto; }
    .lib-toggle-badge:empty { display: none; }
    .lib-panel { margin-top: 2px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); overflow: hidden; }

    /* ── box (bordered list container) ── */
    .box { border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); overflow: hidden; }

    /* tabs inside box */
    .box-tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 8px; background: var(--panel); }
    .tab { padding: 6px 8px 5px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); font-size: 11.5px; font-weight: 600; cursor: pointer; line-height: 1.4; }
    .tab:hover { color: var(--fg); }
    .tab.active { color: var(--fg); border-bottom-color: var(--focus); }

    /* search row inside box */
    .box-search { padding: 5px 8px; border-bottom: 1px solid var(--border); background: var(--panel); }
    .search { width: 100%; padding: 3px 7px; border: 1px solid var(--vscode-input-border, var(--border)); border-radius: var(--r-sm); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-size: 11.5px; font-family: inherit; outline: none; }
    .search:focus { border-color: var(--focus); }
    .search::placeholder { color: var(--vscode-input-placeholderForeground, #818181); }

    /* ── list items ── */
    .item { position: relative; display: grid; grid-template-columns: 8px minmax(0,1fr) auto; align-items: center; gap: 6px; min-height: 36px; padding: 5px 8px; transition: background .1s; }
    .item + .item { border-top: 1px solid rgba(127,127,127,.07); }
    .item:hover { background: var(--hover); }
    .item-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; }
    .item-body { min-width: 0; }
    .item-name { display: block; font-size: 11.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3; }
    .item-sub { display: block; font-size: 10px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3; margin-top: 1px; }
    /* action buttons: hidden until hover so narrow sidebars don't clip content */
    .item-acts { display: flex; align-items: center; gap: 3px; opacity: 0; transition: opacity .1s; }
    .item:hover .item-acts, .item.menu-open .item-acts { opacity: 1; }
    .item.has-update .item-acts { opacity: 1; }
    .update-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-yellow, #d7ba7d); margin-left: 5px; flex-shrink: 0; vertical-align: middle; }
    .icon-update { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--vscode-charts-yellow, #d7ba7d); font-size: 14px; line-height: 1; cursor: pointer; font-family: inherit; }
    .icon-update:hover { border-color: var(--vscode-charts-yellow, #d7ba7d); background: var(--hover); }

    /* ── pill action buttons ── */
    .pill { display: inline-flex; align-items: center; justify-content: center; height: 22px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--r-sm); background: transparent; color: var(--fg); font-size: 10.5px; font-weight: 600; cursor: pointer; white-space: nowrap; font-family: inherit; transition: background .1s, border-color .1s; }
    .pill:hover { background: var(--hover); }
    .pill[disabled] { opacity: .4; cursor: default; }
    .pill.accent { border-color: var(--btn); background: var(--btn); color: var(--btn-fg); }
    .pill.accent:hover { background: var(--btn-h); border-color: var(--btn-h); }
    .pill.danger:hover { color: var(--error); border-color: var(--error); background: transparent; }

    /* ── context menu (details dropdown) ── */
    .menu { position: relative; }
    .menu > summary { list-style: none; }
    .menu > summary::-webkit-details-marker { display: none; }
    .menu-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--muted); font-size: 14px; font-weight: 700; cursor: pointer; line-height: 1; font-family: inherit; }
    .menu-btn:hover, .menu[open] .menu-btn { color: var(--fg); background: var(--hover); border-color: var(--border); }
    .menu-pop { position: fixed; z-index: 9999; min-width: 130px; max-width: calc(100vw - 12px); padding: 3px; border: 1px solid var(--border); border-radius: var(--r); background: var(--vscode-dropdown-background, var(--panel-2)); box-shadow: 0 6px 20px rgba(0,0,0,.36); }
    .menu-item { display: flex; align-items: center; width: 100%; min-height: 26px; border: 0; border-radius: var(--r-sm); padding: 4px 8px; background: transparent; color: var(--fg); font-size: 11.5px; font-family: inherit; text-align: left; cursor: pointer; }
    .menu-item:hover { background: var(--hover); }
    .menu-item.danger { color: var(--error); }
    .menu-item[disabled] { opacity: .4; cursor: default; pointer-events: none; }

    /* ── select dropdowns ── */
    .select-wrap { position: relative; display: inline-block; min-width: 90px; }
    .select-wrap.sm { min-width: 80px; }
    .gx-ctl .select-wrap { flex: 1 1 auto; min-width: 0; display: block; }
    .select-wrap::after { content: ''; position: absolute; right: 9px; top: 50%; transform: translateY(-50%); width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid #aaa; pointer-events: none; }
    .input { width: 100%; height: 22px; padding: 0 24px 0 8px; border: 1px solid var(--vscode-dropdown-border, var(--border)); border-radius: var(--r); background: var(--panel-2); color: var(--vscode-dropdown-foreground, var(--fg)); font-size: 12px; font-family: inherit; outline: none; appearance: none; -webkit-appearance: none; cursor: pointer; box-shadow: inset 0 1px 2px rgba(0,0,0,.2); }
    .input.sm { font-size: 11px; }
    .input:focus { border-color: var(--focus); outline: 1px solid var(--focus); }
    .input:hover { border-color: var(--focus); }

    /* list footer */
    .list-more { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--muted); padding: 5px 8px 6px; border-top: 1px solid rgba(127,127,127,.08); }
    /* Default Library search bar: sticky so it stays visible while scrolling items */
    .lib-panel .box-search { position: sticky; top: 0; z-index: 1; background: var(--panel); border-bottom: 1px solid var(--border); }

    /* ── states ── */
    .empty { display: block; color: var(--muted); font-size: 11.5px; padding: 8px; font-style: italic; }
    .skel { display: flex; flex-direction: column; gap: 7px; padding: 10px 8px; }
    .skel-line { height: 11px; border-radius: 2px; background: linear-gradient(90deg, rgba(127,127,127,.10) 25%, rgba(127,127,127,.18) 37%, rgba(127,127,127,.10) 63%); background-size: 400% 100%; animation: shimmer 1.4s ease infinite; }
    .skel-line:nth-child(2) { width: 68%; }
    .skel-line:nth-child(3) { width: 80%; }
    @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spin { display: inline-block; width: 9px; height: 9px; border: 1.5px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin .65s linear infinite; vertical-align: middle; margin-right: 4px; flex-shrink: 0; }

    /* fallback scroll for non-expanded state */
    #mcp, #plugins, #runs { overflow-y: auto; scrollbar-width: none; }
    #mcp::-webkit-scrollbar, #plugins::-webkit-scrollbar, #runs::-webkit-scrollbar { display: none; }
    .lib-panel { overflow-y: auto; scrollbar-width: none; }
    .lib-panel::-webkit-scrollbar { display: none; }

    footer { display: none; }
  </style>
</head>
<body>
<div class="shell">

  <!-- header: brand + version + refresh -->
  <div class="hdr">
    <span class="mark">AI</span>
    <span class="brand-name">AI StepFlow</span>
    ${this.version ? `<span class="ver">v${this.version}</span>` : ''}
    <button class="icon-btn" id="refresh" title="Refresh" aria-label="Refresh">↻</button>
  </div>

  <!-- scrollable content -->
  <div class="body">

    <!-- library stats -->
    <section class="sec">
      <div class="sec-hdr" id="lib-hdr">
        <span class="sec-label">Library</span>
        <span class="sec-count" id="lib-count"></span>
      </div>
      <div class="stats" id="stats"></div>
      <div id="defaults-toggle"></div>
      <div id="defaults-panel" style="display:none"></div>
    </section>

    <!-- MCP connections -->
    <section class="sec">
      <div class="sec-hdr">
        <button class="sec-toggle" id="mcp-section-toggle" type="button" aria-expanded="false">
          <span class="lib-caret open" id="mcp-caret">&#9658;</span>
          <span class="sec-label">MCP Connections</span>
          <span class="sec-count" id="conn-count"></span>
        </button>
      </div>
      <div class="box" id="mcp-panel">
        <div class="box-tabs" id="mcp-tabs">
          <button class="tab active" type="button" data-tab="installed">Installed</button>
          <button class="tab" type="button" data-tab="available">Available</button>
        </div>
        <div class="box-search">
          <input class="search" id="mcp-search" type="text" placeholder="Filter servers…" autocomplete="off" spellcheck="false">
        </div>
        <div id="mcp"><div class="skel"><div class="skel-line"></div><div class="skel-line"></div></div></div>
      </div>
    </section>

    <!-- plugins -->
    <section class="sec">
      <div class="sec-hdr">
        <button class="sec-toggle" id="plugins-section-toggle" type="button" aria-expanded="false">
          <span class="lib-caret open" id="plugins-caret">&#9658;</span>
          <span class="sec-label">Plugins</span>
          <span class="sec-count" id="plug-count"></span>
        </button>
      </div>
      <div class="box" id="plugins-panel">
        <div class="box-tabs" id="plugin-tabs">
          <button class="tab active" type="button" data-tab="installed">Installed</button>
          <button class="tab" type="button" data-tab="marketplace">Available</button>
        </div>
        <div class="box-search">
          <input class="search" id="plugin-search" type="text" placeholder="Filter plugins…" autocomplete="off" spellcheck="false">
        </div>
        <div id="plugins"><div class="skel"><div class="skel-line"></div><div class="skel-line"></div><div class="skel-line"></div></div></div>
      </div>
    </section>

    <!-- project settings -->
    <section class="sec">
      <div class="sec-hdr">
        <button class="sec-toggle" id="settings-section-toggle" type="button" aria-expanded="false">
          <span class="lib-caret" id="settings-caret">&#9658;</span>
          <span class="sec-label">Project Settings</span>
        </button>
      </div>
      <div class="box" id="settings-panel" style="display:none">
        <div class="setting-row">
          <div>
            <div class="setting-label">AI Response Style</div>
            <div class="setting-desc">Controls verbosity of AI step output</div>
          </div>
          <span class="select-wrap sm"><select id="ai-style-select" class="input sm">
            <option value="default">Default</option>
            <option value="concise">Concise</option>
          </select></span>
        </div>
        <div class="setting-row gx-row" id="gitnexus-setting-row" style="display:none">
          <div class="gx-head">
            <div style="min-width:0">
              <div class="setting-label"><span id="gitnexus-dot" class="gx-dot"></span>GitNexus</div>
              <div class="setting-desc" id="gitnexus-desc">Build the GitNexus knowledge graph</div>
            </div>
            <details class="menu" id="gitnexus-menu">
              <summary class="menu-btn" title="More actions" aria-label="More">···</summary>
              <div class="menu-pop" id="gitnexus-menu-pop"></div>
            </details>
          </div>
          <div class="gx-ctl">
            <span class="select-wrap" id="gitnexus-group-select-wrap" style="display:none"><select id="gitnexus-group-select" class="input"><option value="default">Default (no group)</option></select></span>
            <button id="gitnexus-analyze-btn" class="pill accent" type="button">Analyze</button>
          </div>
        </div>
      </div>
    </section>

    <!-- runs (active + recent) -->
    <section class="sec">
      <div class="sec-hdr">
        <button class="sec-toggle" id="runs-section-toggle" type="button" aria-expanded="false">
          <span class="lib-caret open" id="runs-caret">&#9658;</span>
          <span class="sec-label">Runs</span>
          <span class="sec-count" id="runs-count"></span>
        </button>
      </div>
      <div class="box" id="runs-panel">
        <div class="box-search">
          <input class="search" id="runs-search" type="text" placeholder="Filter runs…" autocomplete="off" spellcheck="false">
        </div>
        <div id="runs"><span class="empty">No runs yet</span></div>
      </div>
    </section>

  </div><!-- /.body -->
</div><!-- /.shell -->
<footer>AI StepFlow</footer>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTime = iso => { const d = new Date(iso); return !isNaN(d.getTime()) ? d.toLocaleString() : esc(iso); };
  const fmtDate = iso => { const d = new Date(iso); if (isNaN(d.getTime())) return esc(iso); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  const statusText = s => s === 'connected' ? 'Connected' : s === 'needs-auth' ? 'Needs auth' : s === 'failed' ? 'Failed' : s || 'Not added';
  const spinHtml = '<span class="spin" aria-hidden="true"></span>';
  const actionMenu = items => items && items.length
    ? '<details class="menu"><summary class="menu-btn" title="More actions" aria-label="More">···</summary><div class="menu-pop">' + items.join('') + '</div></details>'
    : '';
  const menuItem = (label, attrs, danger, disabled) =>
    '<button class="menu-item' + (danger ? ' danger' : '') + '" type="button" ' + (disabled ? 'disabled ' : '') + attrs + '>' + esc(label) + '</button>';

  function positionMenu(menu) {
    const btn = menu.querySelector('.menu-btn');
    const pop = menu.querySelector('.menu-pop');
    if (!btn || !pop) return;

    pop.style.left = '0px';
    pop.style.right = 'auto';
    pop.style.top = '0px';

    const margin = 6;
    const btnRect = btn.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;
    const width = Math.min(popRect.width, Math.max(0, viewportW - margin * 2));
    const height = popRect.height;

    let left = btnRect.right - width;
    left = Math.max(margin, Math.min(left, viewportW - width - margin));

    let top = btnRect.bottom + 4;
    if (top + height > viewportH - margin) {
      top = btnRect.top - height - 4;
    }
    top = Math.max(margin, Math.min(top, viewportH - height - margin));

    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  // Close any open menu when clicking outside it; position opened menu-pop via fixed coords.
  document.addEventListener('click', e => {
    const menu = e.target instanceof Element ? e.target.closest('.menu') : null;
    document.querySelectorAll('.menu[open]').forEach(n => {
      if (n !== menu) {
        n.open = false;
        n.closest('.item')?.classList.remove('menu-open');
      }
    });
  });
  document.addEventListener('toggle', e => {
    const menu = e.target instanceof Element ? e.target.closest('.menu') : null;
    if (!menu) return;
    menu.closest('.item')?.classList.toggle('menu-open', menu.open);
    if (menu.open) positionMenu(menu);
  }, true);
  window.addEventListener('resize', () => {
    document.querySelectorAll('.menu[open]').forEach(positionMenu);
  });

  let activePluginTab = 'installed';
  let pluginQuery = '';
  let installedPlugins = [];
  let availablePlugins = [];
  let lastRunFiles = [];
  let lastRunTotal = 0;
  // lib is included — all 5 sections share the same accordion state and helpers
  const sectionOpen = { lib: false, mcp: false, plugins: false, runs: false, settings: false };

  function _applySection(key, open) {
    sectionOpen[key] = open;
    let toggle, sec, panel, caret;
    if (key === 'lib') {
      toggle = document.getElementById('lib-toggle-btn');
      sec    = document.getElementById('lib-hdr') && document.getElementById('lib-hdr').closest('.sec');
      panel  = document.getElementById('defaults-panel');
      caret  = toggle && toggle.querySelector('.lib-caret');
      if (sec) sec.classList.toggle('expanded', open);
      if (caret) caret.className = 'lib-caret' + (open ? ' open' : '');
      renderDefaultsPanel();
    } else {
      toggle = document.getElementById(key + '-section-toggle');
      sec    = toggle && toggle.closest('.sec');
      panel  = document.getElementById(key + '-panel');
      caret  = document.getElementById(key + '-caret');
      if (sec)    sec.classList.toggle('expanded', open);
      if (panel)  panel.style.display = open ? '' : 'none';
      if (caret)  caret.className = 'lib-caret' + (open ? ' open' : '');
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  function setSectionOpen(key, open) {
    if (open) Object.keys(sectionOpen).filter(k => k !== key).forEach(k => _applySection(k, false));
    _applySection(key, open);
  }

  // lib toggle is rendered dynamically in renderDefaults — wired there
  ['mcp', 'plugins', 'runs', 'settings'].forEach(key => {
    const toggle = document.getElementById(key + '-section-toggle');
    if (!toggle) return;
    toggle.onclick = () => setSectionOpen(key, !sectionOpen[key]);
    _applySection(key, false);
  });

  // Plugin tab switcher
  document.querySelectorAll('#plugin-tabs .tab').forEach(n => {
    n.onclick = () => {
      document.querySelectorAll('#plugin-tabs .tab').forEach(t => t.classList.remove('active'));
      n.classList.add('active');
      activePluginTab = n.getAttribute('data-tab');
      renderPlugins();
    };
  });
  document.getElementById('plugin-search').addEventListener('input', e => {
    pluginQuery = e.target.value.trim().toLowerCase();
    renderPlugins();
  });

  // MCP tabs + search
  let activeMcpTab = 'installed';
  let mcpQuery = '';
  let mcpServers = [];
  document.querySelectorAll('#mcp-tabs .tab').forEach(n => {
    n.onclick = () => {
      document.querySelectorAll('#mcp-tabs .tab').forEach(t => t.classList.remove('active'));
      n.classList.add('active');
      activeMcpTab = n.getAttribute('data-tab');
      renderMcp();
    };
  });
  document.getElementById('mcp-search').addEventListener('input', e => {
    mcpQuery = e.target.value.trim().toLowerCase();
    renderMcp();
  });

  // Runs search
  let runsQuery = '';
  document.getElementById('runs-search').addEventListener('input', e => {
    runsQuery = e.target.value.trim().toLowerCase();
    renderRuns(lastRunFiles, lastRunTotal);
  });

  // ── render functions ──

  function renderStats(s) {
    const items = [['flows', s.flows, 'Flows'], ['agents', s.agents, 'Agents'], ['skills', s.skills, 'Skills']];
    document.getElementById('stats').innerHTML = items.map(([key, n, lbl]) =>
      '<div class="stat" data-tab="' + key + '" title="Open ' + lbl + '">' +
      '<div class="stat-num">' + n + '</div>' +
      '<div class="stat-lbl">' + lbl + '</div>' +
      '</div>'
    ).join('');
    document.querySelectorAll('.stat').forEach(n => {
      n.onclick = () => vscode.postMessage({ type: 'openOverview', tab: n.getAttribute('data-tab') });
    });
    const total = (s.flows || 0) + (s.agents || 0) + (s.skills || 0);
    document.getElementById('lib-count').textContent = total ? String(total) : '';
  }

  let defaultItemsData = [];
  let libQuery = '';
  let libActiveTab = 'agents'; // 'agents' | 'skills' | 'reviews' | 'validators'
  const libPendingOps = new Map(); // filename → 'installing' | 'updating' | 'removing'
  const LIB_TABS = [
    { key: 'agents',     label: 'Agents' },
    { key: 'skills',     label: 'Skills' },
    { key: 'reviews',    label: 'Reviews' },
    { key: 'validators', label: 'Validators' },
  ];

  function renderDefaults(items) {
    defaultItemsData = items || [];
    libPendingOps.clear(); // data refresh = operation settled
    const installedCount = defaultItemsData.filter(i => i.installed).length;
    const toggle = document.getElementById('defaults-toggle');
    toggle.innerHTML =
      '<button class="lib-toggle" id="lib-toggle-btn">' +
      '<span class="lib-caret' + (sectionOpen.lib ? ' open' : '') + '">&#9658;</span>' +
      '<span class="lib-toggle-label">Default Library</span>' +
      (installedCount ? '<span class="lib-toggle-badge">' + installedCount + ' installed</span>' : '') +
      '</button>';
    document.getElementById('lib-toggle-btn').onclick = () => setSectionOpen('lib', !sectionOpen.lib);
    renderDefaultsPanel();
  }

  function fmtDefaultName(name) {
    return name.replace(/^aisf-(?:agent|skill|review|validator)?-?/, '').replace(/-/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());
  }

  function renderDefaultsPanel() {
    const panel = document.getElementById('defaults-panel');
    const btn = document.getElementById('lib-toggle-btn');
    if (btn) btn.querySelector('.lib-caret').className = 'lib-caret' + (sectionOpen.lib ? ' open' : '');
    if (!sectionOpen.lib) { panel.style.display = 'none'; return; }
    panel.style.display = '';

    const q = libQuery;
    const tabItems = defaultItemsData
      .filter(i => i.kind === libActiveTab)
      .sort((a, b) => (Number(!!b.installed) - Number(!!a.installed)) || a.filename.localeCompare(b.filename));
    const items = q
      ? tabItems.filter(i => i.filename.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q))
      : tabItems;

    const tabsHtml = '<div class="box-tabs" id="lib-tabs">' +
      LIB_TABS.map(t => {
        const count = defaultItemsData.filter(i => i.kind === t.key).length;
        return '<button class="tab' + (libActiveTab === t.key ? ' active' : '') + '" type="button" data-lib-tab="' + t.key + '">' +
          t.label + (count ? ' <span class="sec-count">' + count + '</span>' : '') +
          '</button>';
      }).join('') +
      '</div>';

    const itemsHtml = items.length
      ? items.map(item => {
          const pending = libPendingOps.get(item.filename);
          let actsHtml;
          if (pending) {
            const label = pending === 'installing' ? 'Installing…' : pending === 'updating' ? 'Updating…' : 'Removing…';
            actsHtml = '<button class="pill" type="button" disabled>' + spinHtml + label + '</button>';
          } else if (item.installed) {
            actsHtml =
              (item.hasUpdate ? '<button class="icon-update" type="button" data-act="updateDefault" data-kind="' + esc(item.kind) + '" data-filename="' + esc(item.filename) + '" title="Update available">↑</button>' : '') +
              (item.inUse
                ? '<button class="pill" type="button" disabled title="Used by a flow — remove from flows first">Remove</button>'
                : '<button class="pill danger" type="button" data-act="uninstallDefault" data-kind="' + esc(item.kind) + '" data-filename="' + esc(item.filename) + '">Remove</button>');
          } else {
            actsHtml = '<button class="pill accent" type="button" data-act="installDefault" data-kind="' + esc(item.kind) + '" data-filename="' + esc(item.filename) + '">Install</button>';
          }
          return '<div class="item' + (item.hasUpdate ? ' has-update' : '') + '">' +
            '<span class="item-dot" style="background:' + (item.installed ? 'var(--success)' : 'var(--badge)') + '"></span>' +
            '<span class="item-body">' +
              '<span class="item-name" title="' + esc(item.filename) + '">' + esc(item.filename) + (item.hasUpdate ? '<span class="update-dot" title="Update available"></span>' : '') + '</span>' +
              '<span class="item-sub" title="' + esc(item.description) + '">' + esc(item.description) + '</span>' +
            '</span>' +
            '<span class="item-acts">' + actsHtml + '</span>' +
            '</div>';
        }).join('')
      : '<span class="empty">' + (q ? 'No items match "' + esc(q) + '"' : 'No items') + '</span>';

    panel.innerHTML =
      '<div class="lib-panel">' +
        tabsHtml +
        '<div class="box-search"><input class="search" id="lib-search" type="text" placeholder="Filter ' + libActiveTab + '…" autocomplete="off" spellcheck="false" value="' + esc(q) + '"></div>' +
        itemsHtml +
      '</div>';

    panel.querySelectorAll('[data-lib-tab]').forEach(tab => {
      tab.onclick = () => {
        libActiveTab = tab.getAttribute('data-lib-tab');
        libQuery = '';
        renderDefaultsPanel();
      };
    });

    const searchEl = document.getElementById('lib-search');
    if (searchEl) {
      searchEl.addEventListener('input', e => {
        libQuery = e.target.value.trim().toLowerCase();
        renderDefaultsPanel();
      });
    }

    panel.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = () => {
        const act = btn.getAttribute('data-act');
        const kind = btn.getAttribute('data-kind');
        const filename = btn.getAttribute('data-filename');
        const opLabel = act === 'installDefault' ? 'installing' : act === 'updateDefault' ? 'updating' : 'removing';
        libPendingOps.set(filename, opLabel);
        renderDefaultsPanel();
        vscode.postMessage({ type: act === 'installDefault' ? 'installDefaultItem' : act === 'updateDefault' ? 'updateDefaultItem' : 'uninstallDefaultItem', kind, filename });
      };
    });
  }

  const MCP_STATUS = {
    'connected':  { color: 'var(--vscode-charts-green, #73c991)',   label: 'Connected',  rank: 0 },
    'needs-auth': { color: 'var(--vscode-charts-yellow, #d7a000)',  label: 'Needs auth', rank: 1 },
    'unknown':    { color: 'var(--muted, #888)',                     label: 'Unknown',    rank: 2 },
    'failed':     { color: 'var(--vscode-charts-red, #f48771)',     label: 'Failed',     rank: 3 }
  };

  function setMcpData(list) {
    mcpServers = (list || []).slice();
    renderMcp();
    gitnexusConnected = mcpServers.some(s => s.status === 'connected' && s.name.toLowerCase().includes('gitnexus'));
    updateGitnexusRow();
  }

  // GitNexus row state: visibility gated by MCP connection, content driven by index status.
  let gitnexusConnected = false;
  let gitnexusStatus = { indexed: false, stale: false, files: 0, indexedAt: null, registryName: null, groups: [], currentGroup: null, currentAlias: null };

  function gxRelTime(iso) {
    const d = new Date(iso); if (isNaN(d.getTime())) return '';
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 90) return 'just now';
    const m = s / 60; if (m < 90) return Math.round(m) + 'm ago';
    const h = m / 60; if (h < 36) return Math.round(h) + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  // Single merged GitNexus row: status (dot+desc) on the left; contextual action button,
  // group select, and a ··· menu (Analyze/Re-analyze, Open registry, Open group config) on the right.
  function updateGitnexusRow() {
    const row = document.getElementById('gitnexus-setting-row');
    const dot = document.getElementById('gitnexus-dot');
    const desc = document.getElementById('gitnexus-desc');
    const btn = document.getElementById('gitnexus-analyze-btn');
    const sel = document.getElementById('gitnexus-group-select');
    const selWrap = document.getElementById('gitnexus-group-select-wrap');
    const menuPop = document.getElementById('gitnexus-menu-pop');
    if (!row || !dot || !desc || !btn || !sel || !selWrap || !menuPop) return;
    row.style.display = gitnexusConnected ? '' : 'none';
    if (!gitnexusConnected) return;

    const indexed = gitnexusStatus.indexed;
    const stale = gitnexusStatus.stale;
    btn.disabled = false;

    // Status dot + description.
    if (!indexed) {
      dot.style.display = 'none';
      desc.textContent = 'Not indexed — run Analyze';
    } else if (stale) {
      dot.style.display = 'inline-block';
      dot.style.background = 'var(--vscode-charts-yellow, #d7a000)';
      desc.textContent = 'Code changed since last analyze — re-index recommended';
    } else {
      dot.style.display = 'inline-block';
      dot.style.background = 'var(--success)';
      const parts = [];
      if (gitnexusStatus.files) parts.push(gitnexusStatus.files + ' files');
      const t = gxRelTime(gitnexusStatus.indexedAt);
      if (t) parts.push('indexed ' + t);
      const grp = gitnexusStatus.currentGroup ? ' · group: ' + gitnexusStatus.currentGroup : '';
      desc.textContent = 'Up to date' + (parts.length ? ' · ' + parts.join(' · ') : '') + grp;
    }

    // Inline action button only when an action is recommended (not indexed → Analyze, stale → Re-analyze).
    if (!indexed) {
      btn.style.display = ''; btn.textContent = 'Analyze';
    } else if (stale) {
      btn.style.display = ''; btn.textContent = 'Re-analyze';
    } else {
      btn.style.display = 'none';
    }

    // Group select is always shown — picking a group before the first analyze runs
    // analyze + join in one flow, so the user chooses the group up front (no re-analyze).
    selWrap.style.display = '';
    const current = gitnexusStatus.currentGroup || 'default';
    const groups = gitnexusStatus.groups || [];
    sel.innerHTML = '<option value="default">Default (no group)</option>' +
      groups.map(g => '<option value="' + esc(g) + '">' + esc(g) + '</option>').join('') +
      '<option value="__create__">＋ Create new group…</option>';
    sel.value = current;

    // ··· menu: Re-analyze appears here only when there's no inline button (up-to-date).
    const items = [];
    if (indexed && !stale) items.push(menuItem('Re-analyze', 'data-act="analyze"'));
    items.push(menuItem('Open registry file', 'data-act="openRegistry"'));
    if (indexed && gitnexusStatus.currentGroup) items.push(menuItem('Open group config', 'data-act="openGroup"'));
    menuPop.innerHTML = items.join('');
  }

  function renderMcp() {
    const el = document.getElementById('mcp');
    const connected = mcpServers.filter(s => s.status === 'connected').length;
    document.getElementById('conn-count').textContent = connected ? String(connected) : '';
    const q = mcpQuery;

    if (!mcpServers.length) {
      el.innerHTML = '<span class="empty">No MCP connections installed</span>';
      return;
    }
    const rows = mcpServers
      .filter(s => activeMcpTab === 'installed' ? s.status === 'connected' : s.status !== 'connected')
      .filter(s => !q || s.name.toLowerCase().includes(q))
      .sort((a, b) =>
        (MCP_STATUS[a.status] || MCP_STATUS.unknown).rank - (MCP_STATUS[b.status] || MCP_STATUS.unknown).rank
        || a.name.localeCompare(b.name));
    if (activeMcpTab === 'installed' && !connected) {
      el.innerHTML = '<span class="empty">No MCP connections installed</span>';
      return;
    }
    if (activeMcpTab === 'available' && !mcpServers.some(s => s.status !== 'connected')) {
      el.innerHTML = '<span class="empty">No available MCP connections</span>';
      return;
    }
    if (!rows.length) {
      el.innerHTML = '<span class="empty">No match for &ldquo;' + esc(q) + '&rdquo;</span>';
      return;
    }
    el.innerHTML = rows.map(s => {
      const st = MCP_STATUS[s.status] || MCP_STATUS.unknown;
      const tgt = s.target || '';
      const isHttp = tgt.toLowerCase().startsWith('http://') || tgt.toLowerCase().startsWith('https://') || tgt.toUpperCase().endsWith('(HTTP)');
      const isClaudeAi = s.name.startsWith('claude.ai ');
      const canReconnect = (s.status === 'failed' || s.status === 'needs-auth') && tgt && isHttp && !isClaudeAi;
      const canBrowserAuth = isClaudeAi && s.status === 'needs-auth';
      const canRetryLocal = s.status === 'failed' && !isHttp && !isClaudeAi;
      return '<div class="item">' +
        '<span class="item-dot" title="' + esc(s.status) + '" style="background:' + st.color + '"></span>' +
        '<span class="item-body">' +
          '<span class="item-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
          '<span class="item-sub">' + esc(st.label) + '</span>' +
        '</span>' +
        '<span class="item-acts">' +
          '<button class="pill" type="button" data-act="mcpDetails" data-name="' + esc(s.name) + '">Details</button>' +
          (canReconnect
            ? '<button class="pill accent" type="button" data-act="mcpReconnect" data-name="' + esc(s.name) + '" data-target="' + esc(tgt) + '">' +
              (s.status === 'failed' ? 'Retry' : 'Auth') + '</button>'
            : '') +
          (canBrowserAuth
            ? '<button class="pill accent" type="button" data-act="openExternal" data-url="https://claude.ai" title="Authenticate via claude.ai">Auth</button>'
            : '') +
          (canRetryLocal
            ? '<button class="pill accent" type="button" data-act="refresh" title="Re-probe this server">Retry</button>'
            : '') +
        '</span>' +
        '</div>';
    }).join('');
    bindActionButtons(el);
  }

  function setPluginData(installed, available) {
    installedPlugins = installed || [];
    availablePlugins = available || [];
    renderPlugins();
  }

  function renderPanelError(id, label) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<span class="empty">' + esc(label) + ' unavailable</span>';
  }

  function renderPlugins() {
    const el = document.getElementById('plugins');
    document.getElementById('plug-count').textContent = installedPlugins.length ? String(installedPlugins.length) : '';
    const q = pluginQuery;

    if (activePluginTab === 'installed') {
      const rows = installedPlugins.filter(p => !q || p.name.toLowerCase().includes(q));
      if (!installedPlugins.length) { el.innerHTML = '<span class="empty">No plugins installed</span>'; return; }
      if (!rows.length) { el.innerHTML = '<span class="empty">No match for &ldquo;' + esc(q) + '&rdquo;</span>'; return; }
      el.innerHTML = rows.map(p =>
        '<div class="item">' +
        '<span class="item-dot" title="' + (p.enabled ? 'Enabled' : 'Disabled') + '" style="background:' +
          (p.enabled ? 'var(--vscode-charts-green, #73c991)' : 'var(--vscode-charts-red, #f48771)') + '"></span>' +
        '<span class="item-body">' +
          '<span class="item-name" title="' + esc(p.name) + ' · v' + esc(p.version) + '">' + esc(p.name) + '</span>' +
          '<span class="item-sub">' + esc(p.scope) + ' · v' + esc(p.version) + '</span>' +
        '</span>' +
        '<span class="item-acts">' +
          '<button class="pill" type="button" data-act="details" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Details</button>' +
          actionMenu([
            menuItem(p.enabled ? 'Disable' : 'Enable', 'data-act="toggle" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '" data-enable="' + !p.enabled + '"'),
            menuItem('Update', 'data-act="update" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '"'),
            menuItem('Uninstall', 'data-act="uninstall" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '"', true)
          ]) +
        '</span>' +
        '</div>'
      ).join('');
    } else {
      const rows = availablePlugins.filter(p => !q || p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
      if (!availablePlugins.length) { el.innerHTML = '<span class="empty">No marketplace configured</span>'; return; }
      if (!rows.length) { el.innerHTML = '<span class="empty">No match for &ldquo;' + esc(q) + '&rdquo;</span>'; return; }
      el.innerHTML = rows.map(p =>
        '<div class="item">' +
        '<span class="item-dot" style="background:var(--muted)"></span>' +
        '<span class="item-body">' +
          '<span class="item-name" title="' + esc(p.id) + '">' + esc(p.name) + '</span>' +
          '<span class="item-sub" title="' + esc(p.description || p.id) + '">' + esc(p.description || p.id) + '</span>' +
        '</span>' +
        '<span class="item-acts">' +
          '<button class="pill accent" type="button" data-act="install" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Install</button>' +
        '</span>' +
        '</div>'
      ).join('');
    }
    bindActionButtons(el);
  }

  function bindActionButtons(root) {
    root.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = () => {
        const act = btn.getAttribute('data-act');
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-name');
        const locks = ['install', 'update', 'uninstall', 'toggle', 'mcpReconnect', 'deleteRun'].includes(act);
        const menu = btn.closest('.menu');
        if (menu) menu.open = false;

        if (locks) {
          btn.closest('.item')?.querySelectorAll('button').forEach(b => b.disabled = true);
          const label = act === 'install' ? 'Installing…' : act === 'update' ? 'Updating…'
            : act === 'uninstall' ? 'Removing…' : act === 'mcpReconnect' ? 'Connecting…'
            : act === 'deleteRun' ? 'Deleting…' : '…';
          btn.innerHTML = spinHtml + label;
        } else {
          // Transient operations: show spinner briefly, auto-restore after 1.5 s
          const prev = btn.innerHTML;
          btn.disabled = true;
          btn.innerHTML = spinHtml + btn.textContent.trim();
          setTimeout(() => { btn.disabled = false; btn.innerHTML = prev; }, 1500);
        }

        if (act === 'toggle') vscode.postMessage({ type: 'togglePlugin', pluginId: id, pluginName: name, enable: btn.getAttribute('data-enable') === 'true' });
        else if (act === 'install') vscode.postMessage({ type: 'installPlugin', pluginId: id, pluginName: name });
        else if (act === 'update') vscode.postMessage({ type: 'updatePlugin', pluginId: id, pluginName: name });
        else if (act === 'details') vscode.postMessage({ type: 'pluginDetails', pluginId: id, pluginName: name });
        else if (act === 'uninstall') vscode.postMessage({ type: 'uninstallPlugin', pluginId: id, pluginName: name });
        else if (act === 'mcpReconnect') vscode.postMessage({ type: 'reconnectMcp', mcpName: name, mcpTarget: btn.getAttribute('data-target') });
        else if (act === 'mcpDetails') vscode.postMessage({ type: 'mcpDetails', mcpName: name });
        else if (act === 'openRun') vscode.postMessage({ type: 'openRun', flowId: btn.getAttribute('data-flow-id'), runId: btn.getAttribute('data-run-id') });
        else if (act === 'openFile') vscode.postMessage({ type: 'openFile', path: btn.getAttribute('data-path') });
        else if (act === 'deleteRun') vscode.postMessage({ type: 'deleteRun', path: btn.getAttribute('data-path') });
        else if (act === 'openExternal') vscode.postMessage({ type: 'openExternal', url: btn.getAttribute('data-url') });
        else if (act === 'refresh') vscode.postMessage({ type: 'refresh' });
      };
    });
  }

  function bindRowClicks(root) {
    root.querySelectorAll('.item[data-row-act]').forEach(row => {
      row.style.cursor = 'pointer';
      row.onclick = e => {
        if (e.target.closest('button, details, .menu')) return;
        const act = row.getAttribute('data-row-act');
        if (act === 'openOverview') vscode.postMessage({ type: 'openOverview' });
        else if (act === 'openFile') vscode.postMessage({ type: 'openFile', path: row.getAttribute('data-row-path') });
      };
    });
  }

  function renderRuns(files, total) {
    lastRunFiles = files || [];
    lastRunTotal = total || 0;
    const el = document.getElementById('runs');
    const totalCount = total || 0;
    document.getElementById('runs-count').textContent = totalCount ? String(totalCount) : '';

    if (!files || !files.length) {
      el.innerHTML = '<span class="empty">No runs yet</span>';
      return;
    }

    const filteredFiles = runsQuery
      ? files.filter(f => (f.runName || f.flowName || '').toLowerCase().includes(runsQuery))
      : files;

    if (!filteredFiles.length) {
      el.innerHTML = '<span class="empty">No runs match "' + esc(runsQuery) + '"</span>';
      return;
    }

    el.innerHTML = filteredFiles.map(f => {
      const isActive = !!f.isActive;
      const isFinalized = !!f.isClosed;
      const isDone = f.completed === f.total && f.total > 0;
      const isPartial = f.completed > 0 && !isDone;
      const percent = f.total > 0 ? Math.round((f.completed / f.total) * 100) : 0;
      const cardCls = isActive ? ' run-active' : (isDone ? ' run-done' : '');
      const badgeCls = isActive ? 'running' : isFinalized ? 'done' : isDone ? 'done' : isPartial ? 'partial' : '';
      const badgeLabel = isActive ? 'Active' : isFinalized ? '✓ Finalized' : isDone ? '✓ Done' : f.completed + '/' + f.total;
      return '<div class="run-card' + cardCls + '">' +
        '<div class="run-card-head">' +
          '<div class="run-card-titles">' +
            '<div class="run-card-title" title="' + esc(f.runName || f.flowName) + '">' + esc(f.runName || f.flowName) + '</div>' +
            (f.runName ? '<div class="run-card-sub" title="' + esc(f.flowName) + '">' + esc(f.flowName) + '</div>' : '') +
          '</div>' +
          (badgeCls ? '<span class="run-sbadge ' + badgeCls + '">' + badgeLabel + '</span>' : '') +
          '<span class="run-card-acts">' +
            actionMenu([
              menuItem('Open cockpit', 'data-act="openRun" data-flow-id="' + esc(f.flowId) + '" data-run-id="' + esc(f.runId) + '"'),
              menuItem('View run file', 'data-act="openFile" data-path="' + esc(f.filePath) + '"'),
              menuItem('Delete run', 'data-act="deleteRun" data-path="' + esc(f.filePath) + '"', true)
            ]) +
          '</span>' +
        '</div>' +
        '<div class="run-card-bar"><div class="run-card-bar-fill" style="width:' + percent + '%"></div></div>' +
        '<div class="run-card-foot">' +
          '<span class="run-card-meta">' + fmtDate(f.runId) + '</span>' +
          '<span class="run-card-meta">' + f.completed + '/' + f.total + ' steps</span>' +
        '</div>' +
      '</div>';
    }).join('');
    bindActionButtons(el);
  }

  // Async probes arrive after first paint — keep skeletons up until each lands.
  let mcpReceived = false, pluginsReceived = false;

  window.addEventListener('message', e => {
    try {
      const m = e.data;
      if (m.type === 'data') {
        renderStats(m.stats);
        renderDefaults(m.defaultItems || []);
        mcpReceived = true;
        pluginsReceived = true;
        if (m.gitnexus) gitnexusStatus = m.gitnexus;
        setMcpData(m.mcp);
        setPluginData(m.plugins, m.pluginsAvailable);
        renderRuns(m.runFiles, m.totalRunFiles);
        const styleSelect = document.getElementById('ai-style-select');
        if (styleSelect && m.uiPrefs) styleSelect.value = m.uiPrefs['ai:responseStyle'] || 'default';
      } else if (m.type === 'mcp') {
        mcpReceived = true;
        setMcpData(m.mcp);
      } else if (m.type === 'plugins') {
        pluginsReceived = true;
        setPluginData(m.plugins, m.pluginsAvailable);
      } else if (m.type === 'gitnexusAnalyzeStarted') {
        updateGitnexusRow();
      }
    } catch (err) {
      console.error('AI StepFlow sidebar render failed', err);
      renderPanelError('mcp', 'Connections');
      renderPanelError('plugins', 'Plugins');
    }
  });

  document.getElementById('ai-style-select').addEventListener('change', function() {
    vscode.postMessage({ type: 'savePref', key: 'ai:responseStyle', value: this.value });
  });

  document.getElementById('gitnexus-analyze-btn').addEventListener('click', function() {
    const sel = document.getElementById('gitnexus-group-select');
    const group = sel ? sel.value : 'default'; // pre-index: apply the up-front group choice
    this.disabled = true;
    this.textContent = 'Analyzing…';
    vscode.postMessage({ type: 'gitnexusAnalyze', group });
  });

  document.getElementById('gitnexus-group-select').addEventListener('change', function() {
    const current = gitnexusStatus.currentGroup || 'default';
    if (this.value === '__create__') {
      this.value = current; // the create action is async; keep the select on its real value
      vscode.postMessage({ type: 'gitnexusCreateGroup' });
      return;
    }
    // Before the first analyze the select is just a pending choice — the Analyze button applies it.
    if (!gitnexusStatus.indexed) return;
    if (this.value === current) return;
    vscode.postMessage({ type: 'gitnexusSelectGroup', group: this.value });
  });

  document.getElementById('gitnexus-menu-pop').addEventListener('click', function(e) {
    const item = e.target instanceof Element ? e.target.closest('[data-act]') : null;
    if (!item) return;
    const menu = document.getElementById('gitnexus-menu');
    if (menu) menu.open = false;
    const act = item.getAttribute('data-act');
    if (act === 'analyze') vscode.postMessage({ type: 'gitnexusAnalyze' });
    else if (act === 'openRegistry') vscode.postMessage({ type: 'gitnexusOpenRegistry' });
    else if (act === 'openGroup') vscode.postMessage({ type: 'gitnexusOpenGroup' });
  });
</script>
</body>
</html>`;
  }
}
