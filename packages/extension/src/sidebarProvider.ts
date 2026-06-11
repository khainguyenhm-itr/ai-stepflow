import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { ConfigManager } from './configManager.js';
import { StateManager } from './stateManager.js';
import { listMcpServers, addRemoteMcpServer } from './mcp.js';
import type { McpServer } from './mcp.js';
import { listPluginCatalog, togglePlugin, installPlugin, uninstallPlugin } from './plugins.js';
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

      view.webview.onDidReceiveMessage(async (message: { type?: string; path?: string; pluginId?: string; pluginName?: string; enable?: boolean; mcpName?: string; mcpUrl?: string }) => {
        try {
          switch (message?.type) {
            case 'openOverview':
              await vscode.commands.executeCommand('ai-stepflow.openOverview');
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
            case 'uninstallPlugin':
              if (message.pluginId) await this._runPluginTask(message.pluginId, message.pluginName, 'uninstall');
              return;
            case 'addMcp':
              if (message.mcpName && message.mcpUrl) await this._addMcp(message.mcpName, message.mcpUrl);
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

  /** Install or uninstall a plugin with a progress notification, then re-probe the catalog. */
  private async _runPluginTask(pluginId: string, pluginName: string | undefined, action: 'install' | 'uninstall'): Promise<void> {
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
      title: `${action === 'install' ? 'Installing' : 'Uninstalling'} plugin '${label}'…`,
      cancellable: false
    }, async () => {
      const res = action === 'install' ? await installPlugin(pluginId) : await uninstallPlugin(pluginId);
      if (res.ok) {
        vscode.window.showInformationMessage(`AI StepFlow: plugin '${label}' ${action === 'install' ? 'installed' : 'uninstalled'}.`);
      } else {
        vscode.window.showErrorMessage(`AI StepFlow: failed to ${action} plugin. ${res.error}`);
      }
      await this.refresh(true);
    });
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
      --gap: 12px;
      --radius: 7px;
      --hair: 1px solid var(--vscode-panel-border, rgba(127,127,127,.22));
      --surface: var(--vscode-editorWidget-background, rgba(127,127,127,.05));
    }
    * { box-sizing: border-box; }
    body { padding: 0; margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.45; }
    .wrap { padding: 14px 13px 20px; }

    /* Hero */
    .hero { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; }
    .hero .logo { font-size: 18px; line-height: 1; }
    .hero .name { font-size: 14px; font-weight: 700; letter-spacing: .01em; flex: 1; }
    .hero .ver { font-size: 10px; opacity: .45; font-variant-numeric: tabular-nums; }

    /* Buttons */
    button.action { width: 100%; cursor: pointer; border: none; border-radius: var(--radius); padding: 9px; font-size: 12px; font-weight: 600; color: var(--vscode-button-foreground); background: var(--vscode-button-background); transition: background .1s ease; }
    button.action:hover { background: var(--vscode-button-hoverBackground); }
    button.action.secondary { color: var(--vscode-foreground); background: transparent; border: var(--hair); font-weight: 500; margin-top: 9px; }
    button.action.secondary:hover { background: var(--vscode-list-hoverBackground); }

    /* Active run */
    .active { margin-top: 13px; padding: 11px 12px; border-radius: var(--radius); background: var(--surface); border: var(--hair); }
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

    /* Collapsible groups */
    .groups { margin-top: 13px; }
    details.group { border-top: var(--hair); }
    details.group:last-of-type { border-bottom: var(--hair); }
    details.group > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 10px 2px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; opacity: .82; user-select: none; }
    details.group > summary::-webkit-details-marker { display: none; }
    details.group > summary::before { content: '\\203A'; display: inline-block; width: 9px; font-size: 13px; opacity: .55; transition: transform .12s ease; }
    details.group[open] > summary::before { transform: rotate(90deg); }
    details.group > summary:hover { opacity: 1; }
    .count { margin-left: auto; min-width: 18px; text-align: center; font-size: 10px; font-weight: 600; letter-spacing: 0; text-transform: none; opacity: .9; background: rgba(127,127,127,.18); border-radius: 9px; padding: 1px 6px; }
    .count:empty { display: none; }
    .group-body { padding: 2px 2px 14px 17px; }

    /* Library stats */
    .stats { display: flex; gap: 7px; }
    .stat { flex: 1; text-align: center; border: var(--hair); border-radius: var(--radius); padding: 9px 4px; cursor: pointer; transition: border-color .1s ease, background .1s ease; }
    .stat:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
    .stat .num { font-size: 18px; font-weight: 700; line-height: 1.1; }
    .stat .lbl { font-size: 9px; opacity: .6; text-transform: uppercase; letter-spacing: .05em; margin-top: 2px; }
    .lib-status { display: flex; align-items: center; gap: 9px; margin-top: 11px; }
    .lib-status-copy { min-width: 0; }
    .lib-status-title { font-size: 12px; font-weight: 600; }
    .lib-status-sub { font-size: 10.5px; opacity: .65; margin-top: 1px; }
    .help { font-size: 10.5px; opacity: .6; margin-top: 8px; line-height: 1.45; }

    /* Lists / rows */
    .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: 0 0 auto; background: var(--vscode-charts-green, #2ea043); }
    .list { display: flex; flex-direction: column; }
    .row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 5px 0; min-height: 26px; }
    .row + .row { border-top: 1px solid rgba(127,127,127,.08); }
    .row .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .sub { font-size: 10px; opacity: .5; flex: 0 0 auto; font-variant-numeric: tabular-nums; }
    .row.click { cursor: pointer; }
    .row.click:hover .label { text-decoration: underline; }
    .row .acts { display: flex; gap: 4px; flex: 0 0 auto; }
    .del { flex: 0 0 auto; cursor: pointer; border: none; background: transparent; color: var(--vscode-foreground); opacity: 0; padding: 0 3px; font-size: 11px; line-height: 1; }
    .row:hover .del { opacity: .6; }
    .del:hover { opacity: 1; color: var(--vscode-errorForeground, #f14c4c); }
    .pill { flex: 0 0 auto; cursor: pointer; border: var(--hair); background: transparent; color: var(--vscode-foreground); border-radius: 5px; font-size: 9.5px; font-weight: 600; letter-spacing: .03em; padding: 2px 8px; opacity: .9; white-space: nowrap; transition: background .1s ease, opacity .1s ease; }
    .pill:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
    .pill[disabled] { opacity: .4; cursor: default; }
    .pill.primary { border-color: transparent; background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.18)); }
    .pill.primary:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.28)); }
    .pill.danger:hover { color: var(--vscode-errorForeground, #f14c4c); border-color: var(--vscode-errorForeground, #f14c4c); background: transparent; }

    /* Plugin controls */
    .seg { display: flex; background: rgba(127,127,127,.12); border-radius: 6px; padding: 2px; margin-bottom: 9px; }
    .seg-btn { flex: 1; text-align: center; font-size: 10.5px; font-weight: 600; cursor: pointer; padding: 4px 6px; border-radius: 4px; opacity: .65; user-select: none; }
    .seg-btn:hover { opacity: .9; }
    .seg-btn.active { opacity: 1; background: var(--vscode-button-secondaryBackground, var(--surface)); box-shadow: 0 1px 2px rgba(0,0,0,.15); }
    .search { width: 100%; margin-bottom: 8px; padding: 5px 8px; font-size: 11.5px; border-radius: 5px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent)); outline: none; }
    .search:focus { border-color: var(--vscode-focusBorder); }
    .desc { font-size: 10px; opacity: .55; line-height: 1.4; margin: 1px 0 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .plugin-row { flex-direction: column; align-items: stretch; gap: 3px; padding: 7px 0; }
    .plugin-top { display: flex; align-items: center; gap: 8px; }

    /* Loading skeleton — reserves height so async content doesn't shift the layout */
    .skel { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
    .skel-row { height: 12px; border-radius: 4px; background: linear-gradient(90deg, rgba(127,127,127,.10) 25%, rgba(127,127,127,.20) 37%, rgba(127,127,127,.10) 63%); background-size: 400% 100%; animation: shimmer 1.3s ease infinite; }
    .skel-row:nth-child(2) { width: 70%; }
    .skel-row:nth-child(3) { width: 85%; }
    @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

    .muted { opacity: .6; font-size: 11px; }
    .empty { opacity: .55; font-size: 11.5px; font-style: italic; padding: 4px 0; }
    footer { margin-top: 18px; font-size: 10px; opacity: .4; text-align: center; letter-spacing: .04em; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <span class="logo">🐇</span><span class="name">AI StepFlow</span>${this.version ? `<span class="ver">v${this.version}</span>` : ''}
    </div>

    <button class="action" id="open">Open Overview</button>

    <div class="active" id="active-wrap" hidden><div id="active"></div></div>

    <div class="groups">
      <details class="group" id="g-library">
        <summary>Library<span class="count" id="lib-count"></span></summary>
        <div class="group-body">
          <div class="stats" id="stats"></div>
          <div id="defaults"></div>
        </div>
      </details>

      <details class="group">
        <summary>Connections<span class="count" id="conn-count"></span></summary>
        <div class="group-body">
          <div class="seg" id="mcp-tabs">
            <span class="seg-btn active" data-tab="installed">Installed</span>
            <span class="seg-btn" data-tab="available">Available</span>
          </div>
          <input class="search" id="mcp-search" type="text" placeholder="Search MCP servers…" autocomplete="off" spellcheck="false">
          <div id="mcp"><div class="skel"><div class="skel-row"></div><div class="skel-row"></div></div></div>
        </div>
      </details>

      <details class="group">
        <summary>Plugins<span class="count" id="plug-count"></span></summary>
        <div class="group-body">
          <div class="seg" id="plugin-tabs">
            <span class="seg-btn active" data-tab="installed">Installed</span>
            <span class="seg-btn" data-tab="marketplace">Marketplace</span>
          </div>
          <input class="search" id="plugin-search" type="text" placeholder="Search plugins by name…" autocomplete="off" spellcheck="false">
          <div id="plugins"><div class="skel"><div class="skel-row"></div><div class="skel-row"></div><div class="skel-row"></div></div></div>
        </div>
      </details>

      <details class="group">
        <summary>Generated files<span class="count" id="files-count"></span></summary>
        <div class="group-body"><div id="files"><span class="empty">No runs yet</span></div></div>
      </details>
    </div>

    <footer>AI StepFlow</footer>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('open').onclick = () => vscode.postMessage({ type: 'openOverview' });

    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const fmtTime = iso => { const d = new Date(iso); return !isNaN(d.getTime()) ? d.toLocaleString() : esc(iso); };

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
        // Surface the install CTA on first run by opening the Library group.
        document.getElementById('g-library').open = true;
        el.innerHTML = '<button class="action secondary" id="init-def" style="margin-top:10px">Install Professional Library</button>' +
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
          '<button class="action secondary" id="reinit-def">Manage / Reinstall</button>';
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
          return '<div class="row">' +
            '<span class="dot" title="' + esc(s.status) + '" style="background:' + st.color + '"></span>' +
            '<span class="label" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
            (st.label ? '<span class="sub">' + st.label + '</span>' : '') +
            '</div>';
        }).join('') + '</div>';
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
          '<div class="row">' +
          '<span class="dot" title="' + (p.enabled ? 'Enabled' : 'Disabled') + '" style="background:' + (p.enabled ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-red, #f14c4c)') + '"></span>' +
          '<span class="label" title="' + esc(p.name) + ' · v' + esc(p.version) + '">' + esc(p.name) + '</span>' +
          '<span class="sub">' + esc(p.scope) + '</span>' +
          '<span class="acts">' +
          '<button class="pill" data-act="toggle" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '" data-enable="' + !p.enabled + '">' + (p.enabled ? 'Disable' : 'Enable') + '</button>' +
          '<button class="pill danger" data-act="uninstall" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Uninstall</button>' +
          '</span></div>'
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
          btn.textContent = act === 'install' ? 'Installing…' : act === 'uninstall' ? 'Removing…' : '…';
          if (act === 'toggle') vscode.postMessage({ type: 'togglePlugin', pluginId: id, pluginName: name, enable: btn.getAttribute('data-enable') === 'true' });
          else if (act === 'install') vscode.postMessage({ type: 'installPlugin', pluginId: id, pluginName: name });
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
