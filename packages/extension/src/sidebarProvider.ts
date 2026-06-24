import * as vscode from 'vscode';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ConfigManager } from './configManager.js';
import type { BundledKind } from './configManager.js';
import { StateManager } from './stateManager.js';
import { listMcpServers } from './mcp.js';
import type { McpServer } from './mcp.js';
import { listPluginCatalog, togglePlugin } from './plugins.js';
import type { PluginInfo, AvailablePlugin } from './plugins.js';
import { getSidebarHtml } from './sidebarHtml.js';
import { SidebarActions } from './sidebarActions.js';
import type { GitnexusStatus } from './sidebarActions.js';

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
  private _actions: SidebarActions;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private configManager: ConfigManager,
    private stateManager: StateManager,
    private readonly version: string
  ) {
    this._actions = new SidebarActions(
      configManager,
      stateManager,
      (probeMcp) => this.refresh(probeMcp),
      () => this._view,
      () => this._cachedMcp
    );
  }

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
              if (message.path) await this._actions.deleteRun(message.path);
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
              if (message.pluginId) await this._actions.showPluginDetails(message.pluginId, message.pluginName);
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
              if (message.pluginId) await this._actions.runPluginTask(message.pluginId, message.pluginName, 'install');
              return;
            case 'updatePlugin':
              if (message.pluginId) await this._actions.runPluginTask(message.pluginId, message.pluginName, 'update');
              return;
            case 'uninstallPlugin':
              if (message.pluginId) await this._actions.runPluginTask(message.pluginId, message.pluginName, 'uninstall');
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
              if (message.mcpName && message.mcpTarget) await this._actions.reconnectMcp(message.mcpName, message.mcpTarget);
              return;
            case 'mcpDetails':
              if (message.mcpName) await this._actions.showMcpDetails(message.mcpName);
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
              await this._actions.runGitnexusAnalyze(message.group);
              return;
            case 'gitnexusCreateGroup':
              await this._actions.createGitnexusGroup();
              return;
            case 'gitnexusSelectGroup':
              if (message.group) await this._actions.selectGitnexusGroup(message.group);
              return;
            case 'gitnexusOpenRegistry':
              await this._actions.openGitnexusFile(join(homedir(), '.gitnexus', 'registry.json'), 'registry not found yet — run Analyze first.');
              return;
            case 'gitnexusOpenGroup': {
              const st = await this._actions.readGitnexusStatus();
              if (st.currentGroup) await this._actions.openGitnexusFile(join(homedir(), '.gitnexus', 'groups', st.currentGroup, 'group.yaml'), 'group config not found.');
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
        this._actions.readGitnexusStatus().catch(() => ({ indexed: false, stale: false, files: 0, indexedAt: null, registryName: null, groups: [], currentGroup: null, currentAlias: null } as GitnexusStatus))
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
        totalRunFiles: visibleRunFiles.length,
        activeRun: active
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

  private _getHtml(webview: vscode.Webview): string {
    return getSidebarHtml(webview, this.extensionUri, this.version);
  }
}
