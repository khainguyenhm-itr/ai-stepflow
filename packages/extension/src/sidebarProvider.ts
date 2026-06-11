import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { ConfigManager } from './configManager.js';
import type { BundledKind } from './configManager.js';
import { StateManager } from './stateManager.js';
import { listMcpServers, reconnectRemoteMcpServer } from './mcp.js';
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

      view.webview.onDidReceiveMessage(async (message: { type?: string; path?: string; url?: string; pluginId?: string; pluginName?: string; enable?: boolean; mcpName?: string; mcpTarget?: string; tab?: string; kind?: BundledKind; filename?: string; isGlobal?: boolean }) => {
        try {
          switch (message?.type) {
            case 'openOverview':
              if (message.tab) {
                await vscode.commands.executeCommand('ai-stepflow.openTab', message.tab);
              } else {
                await vscode.commands.executeCommand('ai-stepflow.openOverview');
              }
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
      const [flows, agents, skills, runFiles, activeRun, defaultItems] = await Promise.all([
        this.configManager.loadFlows().catch(() => []),
        this.configManager.loadAgents().catch(() => []),
        this.configManager.loadSkills().catch(() => []),
        this.stateManager.listRunFiles().catch(() => []),
        this.stateManager.loadLatestRun().catch(() => undefined),
        this.configManager.listBundledDefaults().catch(() => [])
      ]);
      const flowName = (id: string) => flows.find(f => f.id === id)?.name || id;

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
        defaultItems: annotatedItems,
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
    const content = [
      `Name: ${server.name}`,
      `Status: ${server.status}`,
      `Target: ${server.target || '(not reported)'}`,
      '',
      'Source: claude mcp list'
    ].join('\n');
    const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content });
    await vscode.window.showTextDocument(doc, { preview: true });
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
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--panel); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.4; }
    button { font-family: inherit; cursor: pointer; }

    /* ── shell layout ── */
    .shell { display: flex; flex-direction: column; height: 100vh; }

    /* header row */
    .hdr { display: flex; align-items: center; gap: 7px; padding: 10px 10px 0; flex: 0 0 auto; }
    .mark { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: var(--r); background: var(--btn); color: var(--btn-fg); font-size: 9px; font-weight: 700; flex: 0 0 auto; letter-spacing: .02em; }
    .brand-name { flex: 1; font-size: 12.5px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ver { color: var(--muted); font-size: 10px; flex: 0 0 auto; }
    .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--muted); font-size: 13px; line-height: 1; }
    .icon-btn:hover { color: var(--vscode-foreground); background: var(--hover); }

    /* scrollable content area */
    .body { flex: 1 1 0; overflow-y: auto; overflow-x: hidden; padding: 0 10px 16px; overscroll-behavior: contain; }
    .body::-webkit-scrollbar { width: 5px; }
    .body::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,.4)); border-radius: 999px; }

    /* ── active run card ── */
    .run-card { margin-top: 10px; padding: 9px 10px; border: 1px solid var(--border); border-left: 3px solid var(--btn); border-radius: var(--r); background: var(--panel-2); }
    .run-card[hidden] { display: none; }
    .run-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .run-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-pct { font-size: 10.5px; color: var(--muted); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
    .progress { height: 3px; border-radius: 2px; background: var(--border); overflow: hidden; margin-top: 8px; }
    .progress-fill { height: 100%; background: var(--vscode-progressBar-background, #0e70c0); transition: width .25s ease; }
    .run-step { display: flex; align-items: center; gap: 5px; margin-top: 6px; font-size: 11px; color: var(--muted); overflow: hidden; }
    .run-step > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* badge */
    .badge { display: inline-flex; align-items: center; height: 16px; padding: 0 6px; border-radius: 9px; font-size: 9px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--badge-fg); background: var(--badge); white-space: nowrap; flex: 0 0 auto; }
    .badge.running { background: var(--vscode-charts-blue, var(--focus)); }
    .badge.completed { background: var(--success); }

    /* ── section ── */
    .sec { margin-top: 14px; }
    .sec-hdr { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .sec-label { flex: 1; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
    .sec-count { display: inline-flex; align-items: center; height: 15px; padding: 0 5px; border-radius: 9px; font-size: 9px; font-weight: 700; color: var(--badge-fg); background: var(--badge); }
    .sec-count:empty { display: none; }

    /* ── library stats ── */
    .stats { display: flex; gap: 5px; }
    .stat { flex: 1; min-width: 0; padding: 7px 8px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); cursor: pointer; text-align: center; transition: border-color .1s, background .1s; }
    .stat:hover { border-color: var(--focus); }
    .stat-num { font-size: 18px; font-weight: 700; line-height: 1.1; }
    .stat-lbl { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-top: 2px; }

    /* default library expandable */
    .lib-toggle { display: flex; align-items: center; gap: 7px; margin-top: 6px; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); cursor: pointer; width: 100%; text-align: left; font-family: inherit; color: var(--vscode-foreground); transition: background .1s; }
    .lib-toggle:hover { background: var(--hover); }
    .lib-caret { font-size: 9px; color: var(--muted); transition: transform .15s; flex: 0 0 auto; }
    .lib-caret.open { transform: rotate(90deg); }
    .lib-toggle-label { flex: 1; font-size: 11.5px; font-weight: 500; }
    .lib-toggle-badge { display: inline-flex; align-items: center; height: 15px; padding: 0 5px; border-radius: 9px; font-size: 9px; font-weight: 700; color: var(--badge-fg); background: var(--success); flex: 0 0 auto; }
    .lib-toggle-badge:empty { display: none; }
    .lib-panel { margin-top: 2px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); overflow: hidden; }
    .lib-tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 8px; background: var(--panel); gap: 0; }
    .lib-tab { padding: 5px 8px 4px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); font-size: 11px; font-weight: 600; cursor: pointer; line-height: 1.4; white-space: nowrap; font-family: inherit; }
    .lib-tab:hover { color: var(--vscode-foreground); }
    .lib-tab.active { color: var(--vscode-foreground); border-bottom-color: var(--focus); }

    /* ── box (bordered list container) ── */
    .box { border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); overflow: hidden; }

    /* tabs inside box */
    .box-tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 8px; background: var(--panel); }
    .tab { padding: 6px 8px 5px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); font-size: 11.5px; font-weight: 600; cursor: pointer; line-height: 1.4; }
    .tab:hover { color: var(--vscode-foreground); }
    .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--focus); }

    /* search row inside box */
    .box-search { padding: 5px 7px; border-bottom: 1px solid var(--border); background: var(--panel); }
    .search { width: 100%; padding: 3px 7px; border: 1px solid var(--vscode-input-border, var(--border)); border-radius: var(--r-sm); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-size: 11.5px; font-family: inherit; outline: none; }
    .search:focus { border-color: var(--focus); }
    .search::placeholder { color: var(--vscode-input-placeholderForeground, #818181); }

    /* ── list items ── */
    .item { position: relative; display: grid; grid-template-columns: 8px minmax(0,1fr) auto; align-items: center; gap: 6px; min-height: 36px; padding: 5px 8px 5px 10px; transition: background .1s; }
    .item + .item { border-top: 1px solid rgba(127,127,127,.07); }
    .item:hover { background: var(--hover); }
    .item-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; }
    .item-body { min-width: 0; }
    .item-name { display: block; font-size: 11.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3; }
    .item-sub { display: block; font-size: 10px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3; margin-top: 1px; }
    /* action buttons: hidden until hover so narrow sidebars don't clip content */
    .item-acts { display: flex; align-items: center; gap: 3px; opacity: 0; transition: opacity .1s; }
    .item:hover .item-acts { opacity: 1; }

    /* ── pill action buttons ── */
    .pill { display: inline-flex; align-items: center; justify-content: center; height: 22px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--r-sm); background: transparent; color: var(--vscode-foreground); font-size: 10.5px; font-weight: 600; cursor: pointer; white-space: nowrap; font-family: inherit; transition: background .1s, border-color .1s; }
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
    .menu-btn:hover, .menu[open] .menu-btn { color: var(--vscode-foreground); background: var(--hover); border-color: var(--border); }
    .menu-pop { position: absolute; top: 26px; right: 0; z-index: 20; min-width: 130px; padding: 3px; border: 1px solid var(--border); border-radius: var(--r); background: var(--vscode-dropdown-background, var(--panel-2)); box-shadow: 0 6px 20px rgba(0,0,0,.36); }
    .menu-item { display: flex; align-items: center; width: 100%; min-height: 26px; border: 0; border-radius: var(--r-sm); padding: 4px 8px; background: transparent; color: var(--vscode-foreground); font-size: 11.5px; font-family: inherit; text-align: left; cursor: pointer; }
    .menu-item:hover { background: var(--hover); }
    .menu-item.danger { color: var(--error); }

    /* list footer */
    .list-more { font-size: 10.5px; color: var(--muted); padding: 5px 10px 6px; border-top: 1px solid rgba(127,127,127,.08); }

    /* ── states ── */
    .empty { display: block; color: var(--muted); font-size: 11.5px; padding: 10px; font-style: italic; }
    .skel { display: flex; flex-direction: column; gap: 7px; padding: 12px 10px; }
    .skel-line { height: 11px; border-radius: 2px; background: linear-gradient(90deg, rgba(127,127,127,.10) 25%, rgba(127,127,127,.18) 37%, rgba(127,127,127,.10) 63%); background-size: 400% 100%; animation: shimmer 1.4s ease infinite; }
    .skel-line:nth-child(2) { width: 68%; }
    .skel-line:nth-child(3) { width: 80%; }
    @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

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

    <!-- active run (hidden when idle) -->
    <div class="run-card" id="active-wrap" hidden><div id="active"></div></div>

    <!-- library stats -->
    <section class="sec">
      <div class="sec-hdr">
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
        <span class="sec-label">MCP Connections</span>
        <span class="sec-count" id="conn-count"></span>
      </div>
      <div class="box">
        <div class="box-search">
          <input class="search" id="mcp-search" type="text" placeholder="Filter servers…" autocomplete="off" spellcheck="false">
        </div>
        <div id="mcp"><div class="skel"><div class="skel-line"></div><div class="skel-line"></div></div></div>
      </div>
    </section>

    <!-- plugins -->
    <section class="sec">
      <div class="sec-hdr">
        <span class="sec-label">Plugins</span>
        <span class="sec-count" id="plug-count"></span>
      </div>
      <div class="box">
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

    <!-- recent runs -->
    <section class="sec">
      <div class="sec-hdr">
        <span class="sec-label">Recent Runs</span>
        <span class="sec-count" id="files-count"></span>
      </div>
      <div class="box" id="files"><span class="empty">No runs yet</span></div>
    </section>

  </div><!-- /.body -->
</div><!-- /.shell -->
<footer>AI StepFlow</footer>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTime = iso => { const d = new Date(iso); return !isNaN(d.getTime()) ? d.toLocaleString() : esc(iso); };
  const statusText = s => s === 'connected' ? 'Connected' : s === 'needs-auth' ? 'Needs auth' : s === 'failed' ? 'Failed' : s || 'Not added';
  const actionMenu = items => items && items.length
    ? '<details class="menu"><summary class="menu-btn" title="More actions" aria-label="More">···</summary><div class="menu-pop">' + items.join('') + '</div></details>'
    : '';
  const menuItem = (label, attrs, danger) =>
    '<button class="menu-item' + (danger ? ' danger' : '') + '" type="button" ' + attrs + '>' + esc(label) + '</button>';

  // Close any open menu when clicking outside it.
  document.addEventListener('click', e => {
    const menu = e.target instanceof Element ? e.target.closest('.menu') : null;
    document.querySelectorAll('.menu[open]').forEach(n => { if (n !== menu) n.open = false; });
  });

  let activePluginTab = 'installed';
  let pluginQuery = '';
  let installedPlugins = [];
  let availablePlugins = [];
  const LIMITS = { mcp: 6, pluginsInstalled: 5, pluginsAvailable: 6, files: 5 };

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

  // MCP search
  let mcpQuery = '';
  let mcpServers = [];
  document.getElementById('mcp-search').addEventListener('input', e => {
    mcpQuery = e.target.value.trim().toLowerCase();
    renderMcp();
  });

  // ── render functions ──

  function renderActive(run) {
    const wrap = document.getElementById('active-wrap');
    const el = document.getElementById('active');
    if (!run) { wrap.hidden = true; el.innerHTML = ''; return; }
    wrap.hidden = false;
    const step = run.currentStep
      ? '<div class="run-step"><span class="badge ' + esc(run.currentStep.status) + '">' + esc(run.currentStep.status) + '</span><span>' + esc(run.currentStep.title) + '</span></div>'
      : '';
    el.innerHTML =
      '<div class="run-head">' +
      '<span class="run-name">' + esc(run.flowName) + '</span>' +
      '<span class="run-pct">' + run.completed + '/' + run.total + ' · ' + run.percent + '%</span>' +
      '</div>' +
      '<div class="progress"><div class="progress-fill" style="width:' + run.percent + '%"></div></div>' +
      step;
  }

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

  let defaultLibraryOpen = false;
  let defaultItemsData = [];
  let defaultLibTab = 'agents';
  const LIB_TABS = [
    { key: 'agents',     label: 'Agents' },
    { key: 'skills',     label: 'Skills' },
    { key: 'reviews',    label: 'Reviews' },
    { key: 'validators', label: 'Validators' },
  ];

  function renderDefaults(items) {
    defaultItemsData = items || [];
    const installedCount = defaultItemsData.filter(i => i.installed).length;
    const toggle = document.getElementById('defaults-toggle');
    toggle.innerHTML =
      '<button class="lib-toggle" id="lib-toggle-btn">' +
      '<span class="lib-caret' + (defaultLibraryOpen ? ' open' : '') + '">&#9658;</span>' +
      '<span class="lib-toggle-label">Default Library</span>' +
      (installedCount ? '<span class="lib-toggle-badge">' + installedCount + ' installed</span>' : '') +
      '</button>';
    document.getElementById('lib-toggle-btn').onclick = () => {
      defaultLibraryOpen = !defaultLibraryOpen;
      renderDefaultsPanel();
    };
    renderDefaultsPanel();
  }

  function fmtDefaultName(name) {
    return name.replace(/^aisf-(?:agent|skill|review|validator)?-?/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function renderDefaultsPanel() {
    const panel = document.getElementById('defaults-panel');
    const btn = document.getElementById('lib-toggle-btn');
    if (btn) btn.querySelector('.lib-caret').className = 'lib-caret' + (defaultLibraryOpen ? ' open' : '');
    if (!defaultLibraryOpen) { panel.style.display = 'none'; return; }
    panel.style.display = '';

    const tabsHtml = LIB_TABS.map(t => {
      const count = defaultItemsData.filter(i => i.kind === t.key).length;
      if (!count) return '';
      return '<button class="lib-tab' + (defaultLibTab === t.key ? ' active' : '') + '" type="button" data-libtab="' + t.key + '">' + t.label + ' <span style="opacity:.6;font-weight:400">(' + count + ')</span></button>';
    }).join('');

    const items = defaultItemsData.filter(i => i.kind === defaultLibTab);
    const itemsHtml = items.length
      ? items.map(item =>
          '<div class="item">' +
          '<span class="item-dot" style="background:' + (item.installed ? 'var(--success)' : 'var(--badge)') + '"></span>' +
          '<span class="item-body">' +
            '<span class="item-name" title="' + esc(item.name) + '">' + esc(fmtDefaultName(item.name)) + '</span>' +
            '<span class="item-sub" title="' + esc(item.description) + '">' + esc(item.description) + '</span>' +
          '</span>' +
          '<span class="item-acts">' +
            (item.installed
              ? (item.inUse
                  ? '<button class="pill" type="button" disabled title="Used by a flow — remove from flows first">Remove</button>'
                  : '<button class="pill danger" type="button" data-act="uninstallDefault" data-kind="' + esc(item.kind) + '" data-filename="' + esc(item.filename) + '">Remove</button>')
              : '<button class="pill accent" type="button" data-act="installDefault" data-kind="' + esc(item.kind) + '" data-filename="' + esc(item.filename) + '">Install</button>') +
          '</span>' +
          '</div>'
        ).join('')
      : '<span class="empty">No items</span>';

    panel.innerHTML = '<div class="lib-panel"><div class="lib-tabs" id="lib-tab-bar">' + tabsHtml + '</div>' + itemsHtml + '</div>';

    panel.querySelectorAll('[data-libtab]').forEach(t => {
      t.onclick = () => { defaultLibTab = t.getAttribute('data-libtab'); renderDefaultsPanel(); };
    });
    panel.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = () => {
        const act = btn.getAttribute('data-act');
        const kind = btn.getAttribute('data-kind');
        const filename = btn.getAttribute('data-filename');
        btn.disabled = true;
        btn.textContent = act === 'installDefault' ? 'Installing…' : 'Removing…';
        vscode.postMessage({ type: act === 'installDefault' ? 'installDefaultItem' : 'uninstallDefaultItem', kind, filename });
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
  }

  function renderMcp() {
    const el = document.getElementById('mcp');
    const connected = mcpServers.filter(s => s.status === 'connected').length;
    document.getElementById('conn-count').textContent = mcpServers.length ? connected + '/' + mcpServers.length : '';
    const q = mcpQuery;

    if (!mcpServers.length) {
      el.innerHTML = '<span class="empty">No MCP servers configured</span>';
      return;
    }
    const rows = mcpServers
      .filter(s => !q || s.name.toLowerCase().includes(q))
      .sort((a, b) =>
        (MCP_STATUS[a.status] || MCP_STATUS.unknown).rank - (MCP_STATUS[b.status] || MCP_STATUS.unknown).rank
        || a.name.localeCompare(b.name));
    if (!rows.length) {
      el.innerHTML = '<span class="empty">No match for &ldquo;' + esc(q) + '&rdquo;</span>';
      return;
    }
    const shown = rows.slice(0, LIMITS.mcp);
    el.innerHTML = shown.map(s => {
      const st = MCP_STATUS[s.status] || MCP_STATUS.unknown;
      const tgt = s.target || '';
      const isHttp = tgt.toLowerCase().startsWith('http://') || tgt.toLowerCase().startsWith('https://') || tgt.toUpperCase().endsWith('(HTTP)');
      const canReconnect = (s.status === 'failed' || s.status === 'needs-auth') && tgt && isHttp;
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
        '</span>' +
        '</div>';
    }).join('') +
    (rows.length > shown.length ? '<div class="list-more">Showing ' + shown.length + ' of ' + rows.length + '</div>' : '');
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
      const shown = rows.slice(0, LIMITS.pluginsInstalled);
      el.innerHTML = shown.map(p =>
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
      ).join('') +
      (rows.length > shown.length ? '<div class="list-more">Showing ' + shown.length + ' of ' + rows.length + '</div>' : '');
    } else {
      const rows = availablePlugins.filter(p => !q || p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
      if (!availablePlugins.length) { el.innerHTML = '<span class="empty">No marketplace configured</span>'; return; }
      if (!rows.length) { el.innerHTML = '<span class="empty">No match for &ldquo;' + esc(q) + '&rdquo;</span>'; return; }
      const shown = rows.slice(0, LIMITS.pluginsAvailable);
      el.innerHTML = shown.map(p =>
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
      ).join('') +
      (rows.length > shown.length ? '<div class="list-more">Showing ' + shown.length + ' of ' + rows.length + '</div>' : '');
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
        if (locks) btn.closest('.item')?.querySelectorAll('button').forEach(b => b.disabled = true);
        const menu = btn.closest('.menu');
        if (menu) menu.open = false;
        if (locks) btn.textContent = act === 'install' ? 'Installing…' : act === 'update' ? 'Updating…' : act === 'uninstall' ? 'Removing…' : act === 'mcpReconnect' ? 'Connecting…' : act === 'deleteRun' ? 'Deleting…' : '…';
        if (act === 'toggle') vscode.postMessage({ type: 'togglePlugin', pluginId: id, pluginName: name, enable: btn.getAttribute('data-enable') === 'true' });
        else if (act === 'install') vscode.postMessage({ type: 'installPlugin', pluginId: id, pluginName: name });
        else if (act === 'update') vscode.postMessage({ type: 'updatePlugin', pluginId: id, pluginName: name });
        else if (act === 'details') vscode.postMessage({ type: 'pluginDetails', pluginId: id, pluginName: name });
        else if (act === 'uninstall') vscode.postMessage({ type: 'uninstallPlugin', pluginId: id, pluginName: name });
        else if (act === 'mcpReconnect') vscode.postMessage({ type: 'reconnectMcp', mcpName: name, mcpTarget: btn.getAttribute('data-target') });
        else if (act === 'mcpDetails') vscode.postMessage({ type: 'mcpDetails', mcpName: name });
        else if (act === 'openFile') vscode.postMessage({ type: 'openFile', path: btn.getAttribute('data-path') });
        else if (act === 'deleteRun') vscode.postMessage({ type: 'deleteRun', path: btn.getAttribute('data-path') });
      };
    });
  }

  function renderFiles(files, total) {
    document.getElementById('files-count').textContent = total ? String(total) : '';
    const el = document.getElementById('files');
    if (!files || !files.length) { el.innerHTML = '<span class="empty">No runs yet</span>'; return; }
    const shown = files.slice(0, LIMITS.files);
    el.innerHTML = shown.map(f =>
      '<div class="item">' +
      '<span class="item-dot" style="background:var(--muted)"></span>' +
      '<span class="item-body">' +
        '<span class="item-name" title="' + esc(f.flowName) + '">' + esc(f.flowName) + ' · ' + f.completed + '/' + f.total + '</span>' +
        '<span class="item-sub">' + fmtTime(f.runId) + '</span>' +
      '</span>' +
      '<span class="item-acts">' +
        actionMenu([
          menuItem('Open', 'data-act="openFile" data-path="' + esc(f.filePath) + '"'),
          menuItem('Delete', 'data-act="deleteRun" data-path="' + esc(f.filePath) + '"', true)
        ]) +
      '</span>' +
      '</div>'
    ).join('') +
    (files.length > shown.length ? '<div class="list-more">Showing ' + shown.length + ' of ' + total + ' runs</div>' : '');
    bindActionButtons(el);
  }

  // Async probes arrive after first paint — keep skeletons up until each lands.
  let mcpReceived = false, pluginsReceived = false;

  window.addEventListener('message', e => {
    try {
      const m = e.data;
      if (m.type === 'data') {
        renderActive(m.activeRun);
        renderStats(m.stats);
        renderDefaults(m.defaultItems || []);
        mcpReceived = true;
        pluginsReceived = true;
        setMcpData(m.mcp);
        setPluginData(m.plugins, m.pluginsAvailable);
        renderFiles(m.runFiles, m.totalRunFiles);
      } else if (m.type === 'mcp') {
        mcpReceived = true;
        setMcpData(m.mcp);
      } else if (m.type === 'plugins') {
        pluginsReceived = true;
        setPluginData(m.plugins, m.pluginsAvailable);
      }
    } catch (err) {
      console.error('AI StepFlow sidebar render failed', err);
      renderPanelError('mcp', 'Connections');
      renderPanelError('plugins', 'Plugins');
    }
  });
</script>
</body>
</html>`;
  }
}
