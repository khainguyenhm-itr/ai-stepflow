import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { ConfigManager } from './configManager.js';
import { StateManager } from './stateManager.js';
import { listMcpServers, addRemoteMcpServer, reconnectRemoteMcpServer } from './mcp.js';
import type { McpServer } from './mcp.js';
import { listPluginCatalog, togglePlugin, installPlugin, updatePlugin, uninstallPlugin, pluginDetails } from './plugins.js';
import type { PluginInfo, AvailablePlugin } from './plugins.js';

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

      view.webview.onDidReceiveMessage(async (message: { type?: string; path?: string; url?: string; pluginId?: string; pluginName?: string; enable?: boolean; mcpName?: string; mcpUrl?: string; mcpTarget?: string }) => {
        try {
          switch (message?.type) {
            case 'openOverview':
              await vscode.commands.executeCommand('ai-stepflow.openOverview');
              return;
            case 'refresh':
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
            case 'addMcp':
              if (message.mcpName && message.mcpUrl) await this._addMcp(message.mcpName, message.mcpUrl);
              return;
            case 'reconnectMcp':
              if (message.mcpName && message.mcpTarget) await this._reconnectMcp(message.mcpName, message.mcpTarget);
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
          }
        } catch (e) {
          vscode.window.showErrorMessage(`AI StepFlow: ${e instanceof Error ? e.message : String(e)}`);
        }
      });

      // Repaint when the view is revealed; refresh MCP on first paint.
      view.onDidChangeVisibility(() => { if (view.visible) void this.refresh(false); });
      void this.refresh(true);
    } catch (e) {
      console.error('AI StepFlow: failed to resolve sidebar view', e);
    }
  }

  /** Re-gathers data and pushes it to the webview. Set probeMcp to respawn the CLI. */
  public async refresh(probeMcp: boolean): Promise<void> {
    if (!this._view) return;

    try {
      const [flows, agents, skills, runFiles, activeRun, globalInstalled, projectInstalled] = await Promise.all([
        this.configManager.loadFlows().catch(() => []),
        this.configManager.loadAgents().catch(() => []),
        this.configManager.loadSkills().catch(() => []),
        this.stateManager.listRunFiles().catch(() => []),
        this.stateManager.loadLatestRun().catch(() => undefined),
        this.configManager.isDefaultLibraryInstalled('global').catch(() => false),
        this.configManager.isDefaultLibraryInstalled('project').catch(() => false)
      ]);

      const defaultsInstalled = globalInstalled || projectInstalled;
      const flowName = (id: string) => flows.find(f => f.id === id)?.name || id;

      let active: any = null;
      if (activeRun) {
        const flow = flows.find(f => f.id === activeRun.flowId);
        const total = flow?.steps.length ?? Object.keys(activeRun.steps || {}).length;
        const completed = Object.values(activeRun.steps || {}).filter((s: any) => s.completionStatus === 'done').length;
        // The running step, else the first step not yet done.
        const currentStep = flow?.steps.find(step => activeRun.steps[step.id]?.executionStatus === 'running')
          ?? flow?.steps.find(step => activeRun.steps[step.id]?.completionStatus !== 'done');
        active = {
          flowName: flowName(activeRun.flowId),
          runId: activeRun.runId,
          completed,
          total,
          percent: total ? Math.round((completed / total) * 100) : 0,
          currentStep: currentStep
            ? { title: currentStep.title || currentStep.id, status: activeRun.steps[currentStep.id]?.executionStatus || 'ready' }
            : null
        };
      }

      this._view.webview.postMessage({
        type: 'data',
        stats: { flows: flows.length, agents: agents.length, skills: skills.length },
        defaultsInstalled,
        activeRun: active,
        mcp: this._cachedMcp,
        plugins: this._cachedPlugins,
        pluginsAvailable: this._cachedAvailable,
        runFiles: runFiles.slice(0, 8).map(file => ({
          flowName: flowName(file.flowId),
          runId: file.runId,
          completed: file.completedSteps,
          total: file.totalSteps,
          filePath: file.filePath
        })),
        totalRunFiles: runFiles.length
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
          defaultsInstalled: false,
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

  /** Add a curated remote MCP server (user scope) with progress, then re-probe. */
  private async _addMcp(name: string, url: string): Promise<void> {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Adding MCP server '${name}'…`,
      cancellable: false
    }, async () => {
      const res = await addRemoteMcpServer({ name, url, scope: 'user', cwd: this.configManager.getProjectPath() });
      if (res.ok) {
        vscode.window.showInformationMessage(`AI StepFlow: MCP server '${name}' added. Authenticate it on first use if prompted.`);
      } else {
        vscode.window.showErrorMessage(`AI StepFlow: failed to add MCP server. ${res.error}`);
      }
      await this.refresh(true);
    });
  }

  /** Retry a failed remote MCP server from the sidebar using its current target. */
  private async _reconnectMcp(name: string, target: string): Promise<void> {
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

  /** Deletes a generated run file after a modal confirmation, then repaints. */
  private async _deleteRun(filePath: string): Promise<void> {
    const name = filePath.split(/[\\/]/).pop() || filePath;
    const choice = await vscode.window.showWarningMessage(
      `Delete this run file?\n${name}`,
      { modal: true },
      'Delete'
    );
    if (choice !== 'Delete') return;

    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(filePath));
    } catch (e) {
      vscode.window.showErrorMessage(`AI StepFlow: unable to delete run file. ${e instanceof Error ? e.message : String(e)}`);
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
      --radius: 8px;
      --radius-sm: 6px;
      --hair-color: var(--vscode-panel-border, rgba(127,127,127,.22));
      --hair: 1px solid var(--hair-color);
      --surface: color-mix(in srgb, var(--vscode-sideBar-background, #252526) 92%, var(--vscode-foreground, #fff) 8%);
      --surface-strong: color-mix(in srgb, var(--vscode-sideBar-background, #252526) 84%, var(--vscode-foreground, #fff) 16%);
      --accent-soft: color-mix(in srgb, var(--vscode-button-background, #0e639c) 24%, transparent);
      --muted: var(--vscode-descriptionForeground, rgba(204,204,204,.66));
    }
    * { box-sizing: border-box; }
    body { padding: 0; margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.4; }
    .wrap { padding: 12px 10px 18px; }

    button { font-family: inherit; }
    button.action { width: 100%; cursor: pointer; border: 1px solid transparent; border-radius: var(--radius-sm); padding: 8px 10px; font-size: 12px; font-weight: 700; color: var(--vscode-button-foreground); background: var(--vscode-button-background); transition: background .1s ease, border-color .1s ease; }
    button.action:hover { background: var(--vscode-button-hoverBackground); }
    button.action.secondary { color: var(--vscode-foreground); background: transparent; border: var(--hair); font-weight: 600; }
    button.action.secondary:hover { background: var(--vscode-list-hoverBackground); }
    .icon-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 0; height: 30px; cursor: pointer; border: var(--hair); border-radius: var(--radius-sm); color: var(--vscode-foreground); background: transparent; font-size: 13px; line-height: 1; }
    .icon-btn:hover { background: var(--vscode-list-hoverBackground); }

    .topbar { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; }
    .mark { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 7px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-size: 10px; font-weight: 800; letter-spacing: .02em; box-shadow: inset 0 0 0 1px rgba(255,255,255,.14); }
    .brand { flex: 1; min-width: 0; }
    .brand-name { display: block; overflow: hidden; font-size: 13px; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
    .brand-sub { display: block; color: var(--muted); font-size: 10.5px; font-weight: 500; }
    .ver { color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }

    .command-bar { display: grid; grid-template-columns: minmax(0, 1fr) 30px; gap: 7px; margin-bottom: 10px; }
    .command-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin-bottom: 12px; }
    .command-grid .pill { display: inline-flex; justify-content: center; width: 100%; padding: 6px 6px; }

    .active { margin: 0 0 12px; padding: 10px 11px; border: var(--hair); border-left: 3px solid var(--vscode-button-background); border-radius: var(--radius); background: var(--surface); }
    .active[hidden] { display: none; }
    .run-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .run-flow { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-sub { font-size: 11px; opacity: .7; flex: 0 0 auto; font-variant-numeric: tabular-nums; }
    .bar { height: 5px; border-radius: 3px; background: rgba(127,127,127,.22); overflow: hidden; margin: 9px 0 0; }
    .bar > span { display: block; height: 100%; background: var(--vscode-charts-blue, var(--vscode-focusBorder)); transition: width .25s ease; }
    .step-line { display: flex; align-items: center; gap: 6px; font-size: 11.5px; margin-top: 9px; opacity: .9; }
    .badge { font-size: 9px; padding: 1px 6px; border-radius: 8px; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; background: rgba(127,127,127,.2); }
    .badge.running { background: var(--vscode-charts-blue, #3794ff); color: #fff; }
    .badge.completed { background: var(--vscode-charts-green, #2ea043); color: #fff; }

    .section { margin-top: 13px; }
    .section-head { display: flex; align-items: center; gap: 8px; min-height: 24px; margin-bottom: 7px; }
    .section-title { flex: 1; min-width: 0; overflow: hidden; color: var(--muted); font-size: 10.5px; font-weight: 800; letter-spacing: .055em; text-transform: uppercase; text-overflow: ellipsis; white-space: nowrap; }
    .count { min-width: 18px; text-align: center; font-size: 10px; font-weight: 700; letter-spacing: 0; text-transform: none; background: rgba(127,127,127,.18); border-radius: 9px; padding: 1px 6px; }
    .count:empty { display: none; }
    .panel { border: var(--hair); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
    .panel-pad { padding: 9px; }

    .stats { display: flex; gap: 7px; }
    .stat { flex: 1; min-width: 0; text-align: left; border: var(--hair); border-radius: var(--radius); padding: 8px 7px; cursor: pointer; background: var(--surface); transition: border-color .1s ease, background .1s ease; }
    .stat:hover { border-color: var(--vscode-focusBorder); background: var(--surface-strong); }
    .stat .num { font-size: 18px; font-weight: 700; line-height: 1.1; }
    .stat .lbl { color: var(--muted); font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; }
    .lib-status { display: flex; align-items: center; gap: 9px; margin-top: 9px; padding: 8px 9px; border: var(--hair); border-radius: var(--radius); background: var(--surface); }
    .lib-status-copy { min-width: 0; }
    .lib-status-title { font-size: 12px; font-weight: 600; }
    .lib-status-sub { color: var(--muted); font-size: 10.5px; margin-top: 1px; }
    .help { color: var(--muted); font-size: 10.5px; margin-top: 8px; line-height: 1.45; }
    .tool-row { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 8px 9px; }
    .tool-row + .tool-row { border-top: 1px solid rgba(127,127,127,.08); }
    .tool-main { flex: 1; min-width: 0; }
    .tool-name { display: block; overflow: hidden; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .tool-sub { display: block; overflow: hidden; color: var(--muted); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }

    .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: 0 0 auto; background: var(--vscode-charts-green, #2ea043); }
    .list { display: flex; flex-direction: column; }
    .row { display: flex; align-items: center; gap: 8px; font-size: 12px; min-height: 30px; padding: 7px 9px; }
    .row + .row { border-top: 1px solid rgba(127,127,127,.08); }
    .row .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .sub { font-size: 10px; opacity: .5; flex: 0 0 auto; font-variant-numeric: tabular-nums; }
    .row.click { cursor: pointer; }
    .row.click:hover .label { text-decoration: underline; }
    .row .acts { display: flex; justify-content: flex-end; gap: 4px; flex: 0 0 auto; }
    .del { flex: 0 0 auto; cursor: pointer; border: none; background: transparent; color: var(--vscode-foreground); opacity: 0; padding: 0 3px; font-size: 11px; line-height: 1; }
    .row:hover .del { opacity: .6; }
    .del:hover { opacity: 1; color: var(--vscode-errorForeground, #f14c4c); }
    .pill { flex: 0 0 auto; cursor: pointer; border: var(--hair); background: transparent; color: var(--vscode-foreground); border-radius: var(--radius-sm); font-size: 9.5px; font-weight: 700; letter-spacing: .01em; padding: 3px 7px; white-space: nowrap; transition: background .1s ease, opacity .1s ease, border-color .1s ease; }
    .pill:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
    .pill[disabled] { opacity: .4; cursor: default; }
    .pill.primary { border-color: color-mix(in srgb, var(--vscode-button-background, #0e639c) 52%, var(--hair-color)); background: var(--accent-soft); }
    .pill.primary:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.28)); }
    .pill.danger:hover { color: var(--vscode-errorForeground, #f14c4c); border-color: var(--vscode-errorForeground, #f14c4c); background: transparent; }

    .seg { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px; width: 100%; min-height: 30px; padding: 2px; border: var(--hair); border-radius: 7px; background: rgba(127,127,127,.10); }
    .seg-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 0; width: 100%; border: 0; color: var(--muted); background: transparent; text-align: center; font-size: 11px; font-weight: 600; cursor: pointer; padding: 5px 4px; border-radius: 5px; user-select: none; line-height: 1.2; }
    .seg-btn:hover { color: var(--vscode-foreground); background: rgba(127,127,127,.08); }
    .seg-btn.active { color: var(--vscode-foreground); background: var(--surface-strong); box-shadow: 0 1px 2px rgba(0,0,0,.18); }
    .section-tools { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; margin-bottom: 8px; }
    .search { width: 100%; padding: 6px 8px; font-size: 11.5px; border-radius: 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent)); outline: none; }
    .search:focus { border-color: var(--vscode-focusBorder); }
    .desc { color: var(--muted); font-size: 10px; line-height: 1.4; margin: 0 9px 8px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .plugin-row { flex-direction: column; align-items: stretch; gap: 5px; padding: 8px 0; }
    .plugin-top { display: flex; align-items: center; gap: 8px; }
    .plugin-actions { display: flex; justify-content: flex-start; flex-wrap: wrap; gap: 4px; min-width: 0; padding: 0 9px; }

    .skel { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
    .skel-row { height: 12px; border-radius: 4px; background: linear-gradient(90deg, rgba(127,127,127,.10) 25%, rgba(127,127,127,.20) 37%, rgba(127,127,127,.10) 63%); background-size: 400% 100%; animation: shimmer 1.3s ease infinite; }
    .skel-row:nth-child(2) { width: 70%; }
    .skel-row:nth-child(3) { width: 85%; }
    @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

    .muted { opacity: .6; font-size: 11px; }
    .empty { display: block; color: var(--muted); font-size: 11.5px; font-style: italic; padding: 9px; }
    footer { margin-top: 18px; font-size: 10px; opacity: .4; text-align: center; letter-spacing: .04em; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <span class="mark">AI</span>
      <span class="brand">
        <span class="brand-name">AI StepFlow</span>
        <span class="brand-sub">Agent workflow cockpit</span>
      </span>
      ${this.version ? `<span class="ver">v${this.version}</span>` : ''}
    </div>

    <div class="command-bar">
      <button class="action" id="open">Open Overview</button>
      <button class="icon-btn" id="refresh" title="Refresh sidebar" aria-label="Refresh sidebar">↻</button>
    </div>

    <div class="active" id="active-wrap" hidden><div id="active"></div></div>

    <div class="command-grid">
      <button class="pill primary" id="ast-scan" type="button">Scan AST</button>
      <button class="pill" id="ast-register" type="button">Register MCP</button>
      <button class="pill" id="ast-settings" type="button">AST Settings</button>
      <button class="pill" id="ast-refresh" type="button">Refresh Data</button>
    </div>

    <section class="section" id="g-library">
      <div class="section-head">
        <span class="section-title">Workspace Library</span>
        <span class="count" id="lib-count"></span>
      </div>
      <div id="stats" class="stats"></div>
      <div id="defaults"></div>
    </section>

    <section class="section">
      <div class="section-head">
        <span class="section-title">Connections</span>
        <span class="count" id="conn-count"></span>
      </div>
      <div class="section-tools">
        <div class="seg" id="mcp-tabs">
          <button class="seg-btn active" type="button" data-tab="installed">Installed</button>
          <button class="seg-btn" type="button" data-tab="available">Available</button>
        </div>
        <input class="search" id="mcp-search" type="text" placeholder="Search MCP servers…" autocomplete="off" spellcheck="false">
      </div>
      <div id="mcp" class="panel"><div class="skel"><div class="skel-row"></div><div class="skel-row"></div></div></div>
    </section>

    <section class="section">
      <div class="section-head">
        <span class="section-title">Plugins</span>
        <span class="count" id="plug-count"></span>
      </div>
      <div class="section-tools">
        <div class="seg" id="plugin-tabs">
          <button class="seg-btn active" type="button" data-tab="installed">Installed</button>
          <button class="seg-btn" type="button" data-tab="marketplace">Available</button>
        </div>
        <input class="search" id="plugin-search" type="text" placeholder="Search plugins by name…" autocomplete="off" spellcheck="false">
      </div>
      <div id="plugins" class="panel"><div class="skel"><div class="skel-row"></div><div class="skel-row"></div><div class="skel-row"></div></div></div>
    </section>

    <section class="section">
      <div class="section-head">
        <span class="section-title">Generated Files</span>
        <span class="count" id="files-count"></span>
      </div>
      <div id="files" class="panel"><span class="empty">No runs yet</span></div>
    </section>

    <footer>AI StepFlow</footer>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('open').onclick = () => vscode.postMessage({ type: 'openOverview' });
    document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
    document.getElementById('ast-scan').onclick = () => vscode.postMessage({ type: 'astScan' });
    document.getElementById('ast-register').onclick = () => vscode.postMessage({ type: 'astRegister' });
    document.getElementById('ast-settings').onclick = () => vscode.postMessage({ type: 'openAstSettings' });
    document.getElementById('ast-refresh').onclick = () => vscode.postMessage({ type: 'refresh' });

    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const fmtTime = iso => { const d = new Date(iso); return !isNaN(d.getTime()) ? d.toLocaleString() : esc(iso); };
    const statusText = s => s === 'connected' ? 'Connected' : s === 'needs-auth' ? 'Auth' : s === 'failed' ? 'Failed' : s ? s : 'Not added';

    let activePluginTab = 'installed';
    let pluginQuery = '';
    let installedPlugins = [];
    let availablePlugins = [];

    document.querySelectorAll('#plugin-tabs .seg-btn').forEach(n => {
      n.onclick = () => {
        document.querySelectorAll('#plugin-tabs .seg-btn').forEach(t => t.classList.remove('active'));
        n.classList.add('active');
        activePluginTab = n.getAttribute('data-tab');
        renderPlugins();
      };
    });
    document.getElementById('plugin-search').addEventListener('input', e => {
      pluginQuery = e.target.value.trim().toLowerCase();
      renderPlugins();
    });

    // Curated catalog of popular remote (HTTP) MCP servers offered under the "Available" tab.
    // All add cleanly with one CLI call; auth (where needed) happens on first use.
    const MCP_CATALOG = [
      { name: 'github', url: 'https://api.githubcopilot.com/mcp/', desc: 'GitHub repos, issues, pull requests, and code search.' },
      { name: 'sentry', url: 'https://mcp.sentry.dev/mcp', desc: 'Error tracking and performance monitoring.' },
      { name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp', desc: 'Ask questions about any public GitHub repo (no auth).' },
      { name: 'context7', url: 'https://mcp.context7.com/mcp', desc: 'Up-to-date documentation for libraries and frameworks.' },
      { name: 'huggingface', url: 'https://huggingface.co/mcp', desc: 'Search models, datasets, and Spaces on Hugging Face.' },
      { name: 'cloudflare-docs', url: 'https://docs.mcp.cloudflare.com/mcp', desc: 'Cloudflare product documentation (no auth).' },
      { name: 'stripe', url: 'https://mcp.stripe.com', desc: 'Stripe payments, billing, and customer data.' }
    ];

    let activeMcpTab = 'installed';
    let mcpQuery = '';
    let mcpServers = [];

    document.querySelectorAll('#mcp-tabs .seg-btn').forEach(n => {
      n.onclick = () => {
        document.querySelectorAll('#mcp-tabs .seg-btn').forEach(t => t.classList.remove('active'));
        n.classList.add('active');
        activeMcpTab = n.getAttribute('data-tab');
        renderMcp();
      };
    });
    document.getElementById('mcp-search').addEventListener('input', e => {
      mcpQuery = e.target.value.trim().toLowerCase();
      renderMcp();
    });

    function renderActive(run) {
      const wrap = document.getElementById('active-wrap');
      const el = document.getElementById('active');
      if (!run) { wrap.hidden = true; el.innerHTML = ''; return; }
      wrap.hidden = false;
      const step = run.currentStep
        ? '<div class="step-line"><span class="badge ' + esc(run.currentStep.status) + '">' + esc(run.currentStep.status) + '</span><span>' + esc(run.currentStep.title) + '</span></div>'
        : '';
      el.innerHTML =
        '<div class="run-head"><span class="run-flow">' + esc(run.flowName) + '</span>' +
        '<span class="run-sub">' + run.completed + '/' + run.total + ' · ' + run.percent + '%</span></div>' +
        '<div class="bar"><span style="width:' + run.percent + '%"></span></div>' + step;
    }

    function renderStats(s) {
      const items = [['flows', s.flows, 'Workflows'], ['agents', s.agents, 'Agents'], ['skills', s.skills, 'Skills']];
      document.getElementById('stats').innerHTML = items.map(i =>
        '<div class="stat" data-tab="' + i[0] + '"><div class="num">' + i[1] + '</div><div class="lbl">' + i[2] + '</div></div>'
      ).join('');
      document.querySelectorAll('.stat').forEach(n => n.onclick = () => vscode.postMessage({ type: 'openOverview' }));
      const total = (s.flows || 0) + (s.agents || 0) + (s.skills || 0);
      document.getElementById('lib-count').textContent = total ? String(total) : '';
    }

    function renderDefaults(installed) {
      const el = document.getElementById('defaults');
      if (!installed) {
        el.innerHTML = '<button class="action secondary" id="init-def" style="margin-top:9px">Install Professional Library</button>' +
          '<div class="help">Adds professional SDLC agents &amp; skills to ~/.claude or your project .claude folder.</div>';
        const btn = document.getElementById('init-def');
        if (btn) btn.onclick = () => vscode.postMessage({ type: 'installDefaults' });
      } else {
        el.innerHTML = '<div class="lib-status">' +
          '<span class="dot"></span>' +
          '<div class="lib-status-copy">' +
          '<div class="lib-status-title">Professional Library</div>' +
          '<div class="lib-status-sub">Built-in agents &amp; skills installed.</div>' +
          '</div></div>' +
          '<button class="action secondary" id="reinit-def" style="margin-top:9px">Manage / Reinstall</button>';
        const btn = document.getElementById('reinit-def');
        if (btn) btn.onclick = () => vscode.postMessage({ type: 'installDefaults' });
      }
    }

    const MCP_STATUS = {
      'connected':  { color: 'var(--vscode-charts-green, #2ea043)', label: '', rank: 0 },
      'needs-auth': { color: 'var(--vscode-charts-yellow, #d7a000)', label: 'Needs auth', rank: 1 },
      'unknown':    { color: 'var(--vscode-descriptionForeground, #888)', label: '', rank: 2 },
      'failed':     { color: 'var(--vscode-charts-red, #f14c4c)', label: 'Failed', rank: 3 }
    };

    function setMcpData(list) {
      mcpServers = (list || []).slice();
      renderMcp();
      if (pluginsReceived) renderPlugins();
    }

    function renderMcp() {
      const el = document.getElementById('mcp');
      const connected = mcpServers.filter(s => s.status === 'connected').length;
      // Badge shows connected / total so a wall of "needs auth" rows doesn't read as healthy.
      document.getElementById('conn-count').textContent = mcpServers.length ? connected + '/' + mcpServers.length : '';
      const q = mcpQuery;

      if (activeMcpTab === 'installed') {
        const rows = mcpServers.filter(s => !q || s.name.toLowerCase().includes(q)).sort((a, b) =>
          (MCP_STATUS[a.status] || MCP_STATUS.unknown).rank - (MCP_STATUS[b.status] || MCP_STATUS.unknown).rank
          || a.name.localeCompare(b.name));
        if (!mcpServers.length) { el.innerHTML = '<span class="empty">No MCP servers</span>'; return; }
        if (!rows.length) { el.innerHTML = '<span class="empty">No match for &ldquo;' + esc(q) + '&rdquo;</span>'; return; }
        el.innerHTML = '<div class="list">' + rows.map(s => {
          const st = MCP_STATUS[s.status] || MCP_STATUS.unknown;
          const targetText = s.target || '';
          const targetLower = targetText.toLowerCase();
          const isHttpTarget = targetLower.startsWith('http://') || targetLower.startsWith('https://') || targetText.toUpperCase().endsWith('(HTTP)');
          const canReconnect = (s.status === 'failed' || s.status === 'needs-auth') && s.target && isHttpTarget;
          return '<div class="tool-row">' +
            '<span class="dot" title="' + esc(s.status) + '" style="background:' + st.color + '"></span>' +
            '<span class="tool-main"><span class="tool-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
            '<span class="tool-sub" title="' + esc(s.target || statusText(s.status)) + '">' + esc(st.label || statusText(s.status)) + '</span></span>' +
            (canReconnect ? '<button class="pill primary" data-mcp-reconnect="' + esc(s.name) + '" data-target="' + esc(s.target) + '">' + (s.status === 'failed' ? 'Reconnect' : 'Connect') + '</button>' : '') +
            '</div>';
        }).join('') + '</div>';
        el.querySelectorAll('button[data-mcp-reconnect]').forEach(btn => {
          btn.onclick = () => {
            btn.disabled = true;
            btn.textContent = 'Connecting…';
            vscode.postMessage({ type: 'reconnectMcp', mcpName: btn.getAttribute('data-mcp-reconnect'), mcpTarget: btn.getAttribute('data-target') });
          };
        });
      } else {
        const installedNames = new Set(mcpServers.map(s => s.name.toLowerCase()));
        const rows = MCP_CATALOG.filter(c => !installedNames.has(c.name.toLowerCase()))
          .filter(c => !q || c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q));
        if (!rows.length) { el.innerHTML = '<span class="empty">' + (q ? 'No match for &ldquo;' + esc(q) + '&rdquo;' : 'All popular servers added') + '</span>'; return; }
        el.innerHTML = '<div class="list">' + rows.map(c =>
          '<div class="row plugin-row">' +
          '<div class="plugin-top">' +
          '<span class="label" title="' + esc(c.url) + '">' + esc(c.name) + '</span>' +
          '<button class="pill primary" data-mcp-add="' + esc(c.name) + '" data-url="' + esc(c.url) + '">Add</button>' +
          '</div>' +
          '<div class="desc">' + esc(c.desc) + '</div>' +
          '</div>'
        ).join('') + '</div>';
        el.querySelectorAll('button[data-mcp-add]').forEach(btn => {
          btn.onclick = () => {
            btn.disabled = true;
            btn.textContent = 'Adding…';
            vscode.postMessage({ type: 'addMcp', mcpName: btn.getAttribute('data-mcp-add'), mcpUrl: btn.getAttribute('data-url') });
          };
        });
      }
    }

    function setPluginData(installed, available) {
      installedPlugins = installed || [];
      availablePlugins = available || [];
      renderPlugins();
    }

    function renderPlugins() {
      const el = document.getElementById('plugins');
      document.getElementById('plug-count').textContent = installedPlugins.length ? String(installedPlugins.length) : '';
      const q = pluginQuery;

      if (activePluginTab === 'installed') {
        const rows = installedPlugins.filter(p => !q || p.name.toLowerCase().includes(q));
        if (!installedPlugins.length) { el.innerHTML = '<span class="empty">No plugins installed</span>'; return; }
        if (!rows.length) { el.innerHTML = '<span class="empty">No match for &ldquo;' + esc(q) + '&rdquo;</span>'; return; }
        el.innerHTML = '<div class="list">' + rows.map(p =>
          '<div class="row plugin-row">' +
          '<div class="plugin-top">' +
          '<span class="dot" title="' + (p.enabled ? 'Enabled' : 'Disabled') + '" style="background:' + (p.enabled ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-red, #f14c4c)') + '"></span>' +
          '<span class="label" title="' + esc(p.name) + ' · v' + esc(p.version) + '">' + esc(p.name) + '</span>' +
          '<span class="sub">' + esc(p.scope) + '</span>' +
          '</div>' +
          '<div class="plugin-actions acts">' +
          '<button class="pill" data-act="toggle" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '" data-enable="' + !p.enabled + '">' + (p.enabled ? 'Disable' : 'Enable') + '</button>' +
          '<button class="pill" data-act="details" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Details</button>' +
          '<button class="pill" data-act="update" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Update</button>' +
          '<button class="pill danger" data-act="uninstall" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Uninstall</button>' +
          '</div></div>'
        ).join('') + '</div>';
      } else {
        const rows = availablePlugins.filter(p => !q || p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
        if (!availablePlugins.length) { el.innerHTML = '<span class="empty">No marketplace configured</span>'; return; }
        if (!rows.length) { el.innerHTML = '<span class="empty">No match for &ldquo;' + esc(q) + '&rdquo;</span>'; return; }
        el.innerHTML = '<div class="list">' + rows.slice(0, 60).map(p =>
          '<div class="row plugin-row">' +
          '<div class="plugin-top">' +
          '<span class="label" title="' + esc(p.id) + '">' + esc(p.name) + '</span>' +
          '<button class="pill primary" data-act="install" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Install</button>' +
          '</div>' +
          (p.description ? '<div class="desc">' + esc(p.description) + '</div>' : '') +
          '</div>'
        ).join('') + '</div>' +
        (rows.length > 60 ? '<div class="muted" style="margin-top:6px">Showing 60 of ' + rows.length + ' — refine your search.</div>' : '');
      }

      el.querySelectorAll('button[data-act]').forEach(btn => {
        btn.onclick = () => {
          const act = btn.getAttribute('data-act');
          const id = btn.getAttribute('data-id');
          const name = btn.getAttribute('data-name');
          // Optimistic feedback: lock the row's buttons so the click registers instantly.
          btn.closest('.acts, .plugin-top')?.querySelectorAll('button').forEach(b => b.disabled = true);
          btn.textContent = act === 'install' ? 'Installing…' : act === 'update' ? 'Updating…' : act === 'uninstall' ? 'Removing…' : act === 'details' ? 'Opening…' : act === 'connect' ? 'Opening…' : '…';
          if (act === 'toggle') vscode.postMessage({ type: 'togglePlugin', pluginId: id, pluginName: name, enable: btn.getAttribute('data-enable') === 'true' });
          else if (act === 'install') vscode.postMessage({ type: 'installPlugin', pluginId: id, pluginName: name });
          else if (act === 'update') vscode.postMessage({ type: 'updatePlugin', pluginId: id, pluginName: name });
          else if (act === 'details') vscode.postMessage({ type: 'pluginDetails', pluginId: id, pluginName: name });
          else if (act === 'uninstall') vscode.postMessage({ type: 'uninstallPlugin', pluginId: id, pluginName: name });
        };
      });
    }

    function renderFiles(files, total) {
      document.getElementById('files-count').textContent = total ? String(total) : '';
      const el = document.getElementById('files');
      if (!files || !files.length) { el.innerHTML = '<span class="empty">No runs yet</span>'; return; }
      el.innerHTML = '<div class="list">' + files.map(f =>
        '<div class="row click" data-path="' + esc(f.filePath) + '">' +
        '<span class="label">' + esc(f.flowName) + ' · ' + f.completed + '/' + f.total + '</span>' +
        '<span class="muted">' + fmtTime(f.runId) + '</span>' +
        '<button class="del" title="Delete run file">🗑</button></div>'
      ).join('') + '</div>';
      el.querySelectorAll('.row.click').forEach(n => {
        const path = n.getAttribute('data-path');
        n.onclick = () => vscode.postMessage({ type: 'openFile', path });
        const delBtn = n.querySelector('.del');
        if (delBtn) delBtn.onclick = ev => { ev.stopPropagation(); vscode.postMessage({ type: 'deleteRun', path }); };
      });
    }

    // Async probes (MCP, plugins) arrive after the first paint. Until each lands once,
    // leave its loading skeleton up instead of flashing an empty state from the cold cache.
    let mcpReceived = false, pluginsReceived = false;

    window.addEventListener('message', e => {
      const m = e.data;
      if (m.type === 'data') {
        renderActive(m.activeRun);
        renderStats(m.stats);
        renderDefaults(m.defaultsInstalled);
        if (mcpReceived) setMcpData(m.mcp);
        if (pluginsReceived) setPluginData(m.plugins, m.pluginsAvailable);
        renderFiles(m.runFiles, m.totalRunFiles);
      } else if (m.type === 'mcp') {
        mcpReceived = true;
        setMcpData(m.mcp);
      } else if (m.type === 'plugins') {
        pluginsReceived = true;
        setPluginData(m.plugins, m.pluginsAvailable);
      }
    });
  </script>
</body>
</html>`;
  }
}
