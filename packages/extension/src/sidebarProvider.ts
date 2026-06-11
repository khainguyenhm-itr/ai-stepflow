import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { ConfigManager } from './configManager.js';
import { StateManager } from './stateManager.js';
import { listConnectedMcpServers } from './mcp.js';
import { listPlugins, togglePlugin, installPlugin } from './plugins.js';

/**
 * Renders the activity-bar sidebar as a compact dashboard: the active run, library
 * counts, connected MCP servers, Claude plugins, and the run files this extension generated.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ai-stepflow-home';
  private _view?: vscode.WebviewView;
  /** Last MCP probe result, reused on cheap refreshes so we don't respawn the CLI. */
  private _cachedMcp: string[] = [];
  /** Last plugin-list result, reused on cheap refreshes so we don't respawn the CLI. */
  private _cachedPlugins: Awaited<ReturnType<typeof listPlugins>> = [];

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

      view.webview.onDidReceiveMessage(async (message: { type?: string; path?: string; pluginName?: string; enable?: boolean }) => {
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
              if (message.pluginName && typeof message.enable === 'boolean') {
                const res = await togglePlugin(message.pluginName, message.enable);
                if (res.ok) {
                  vscode.window.showInformationMessage(`AI StepFlow: plugin '${message.pluginName}' ${message.enable ? 'enabled' : 'disabled'}.`);
                  await this.refresh(false);
                } else {
                  vscode.window.showErrorMessage(`AI StepFlow: failed to toggle plugin. ${res.error}`);
                }
              }
              return;
            case 'installPlugin':
              if (message.pluginName) {
                await vscode.window.withProgress({
                  location: vscode.ProgressLocation.Notification,
                  title: `Installing plugin '${message.pluginName}'...`,
                  cancellable: false
                }, async () => {
                  const res = await installPlugin(message.pluginName!);
                  if (res.ok) {
                    vscode.window.showInformationMessage(`AI StepFlow: plugin '${message.pluginName}' installed.`);
                    await this.refresh(false);
                  } else {
                    vscode.window.showErrorMessage(`AI StepFlow: failed to install plugin. ${res.error}`);
                  }
                });
              }
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
        void listConnectedMcpServers(this.configManager.getProjectPath()).then(mcp => {
          this._cachedMcp = mcp;
          this._view?.webview.postMessage({ type: 'mcp', mcp });
        }).catch(err => {
          console.error('AI StepFlow: MCP probe failed', err);
        });
        void listPlugins().then(plugins => {
          this._cachedPlugins = plugins;
          this._view?.webview.postMessage({ type: 'plugins', plugins });
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
          runFiles: [],
          totalRunFiles: 0
        });
      }
    }
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
    body { padding: 0; margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .wrap { padding: 12px 12px 16px; }
    .hero { margin-bottom: 16px; }
    .hero-title { font-size: 14px; font-weight: 600; letter-spacing: .01em; }
    .hero-sub { font-size: 11px; line-height: 1.45; opacity: .7; margin: 4px 0 10px; }
    button.action { width: 100%; cursor: pointer; border: none; border-radius: 4px; padding: 7px 8px; font-size: 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.action:hover { background: var(--vscode-button-hoverBackground); }
    button.action.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background, transparent)); border: 1px solid var(--vscode-panel-border, var(--vscode-input-border)); }
    button.action.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
    .footer { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--vscode-panel-border, var(--vscode-input-border)); font-size: 10px; opacity: .5; text-align: center; letter-spacing: .03em; }
    .section { margin-bottom: 16px; }
    .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .7; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
    .card { border: 1px solid var(--vscode-panel-border, var(--vscode-input-border)); border-radius: 6px; padding: 10px; background: var(--vscode-editorWidget-background, transparent); }
    .stats { display: flex; gap: 6px; }
    .stat { flex: 1; text-align: center; border: 1px solid var(--vscode-panel-border, var(--vscode-input-border)); border-radius: 6px; padding: 8px 4px; cursor: pointer; }
    .stat:hover { border-color: var(--vscode-focusBorder); }
    .stat .num { font-size: 18px; font-weight: 600; }
    .stat .lbl { font-size: 10px; opacity: .7; text-transform: uppercase; letter-spacing: .04em; }
    .library-actions { margin-top: 8px; }
    .library-status { display: flex; flex-direction: column; align-items: stretch; gap: 10px; margin-top: 8px; padding: 10px; border: 1px solid var(--vscode-panel-border, var(--vscode-input-border)); border-radius: 8px; background: var(--vscode-editorWidget-background, transparent); }
    .library-status-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .library-status-copy { min-width: 0; }
    .library-status-title { font-size: 12px; font-weight: 600; }
    .library-status-sub { font-size: 11px; opacity: .7; margin-top: 2px; }
    .run-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .run-flow { font-weight: 600; }
    .run-sub { font-size: 11px; opacity: .75; }
    .bar { height: 5px; border-radius: 3px; background: var(--vscode-progressBar-background, rgba(127,127,127,.25)); overflow: hidden; margin: 8px 0 6px; }
    .bar > span { display: block; height: 100%; background: var(--vscode-progressBar-background, var(--vscode-focusBorder)); background: var(--vscode-charts-blue, var(--vscode-focusBorder)); }
    .step-line { display: flex; align-items: center; gap: 6px; font-size: 12px; }
    .badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; text-transform: uppercase; letter-spacing: .03em; background: rgba(127,127,127,.2); }
    .badge.running { background: var(--vscode-charts-blue, #3794ff); color: #fff; }
    .badge.completed { background: var(--vscode-charts-green, #2ea043); color: #fff; }
    .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: 0 0 auto; background: var(--vscode-charts-green, #2ea043); }
    .list { display: flex; flex-direction: column; gap: 4px; }
    .row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 0; }
    .row .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row.click { cursor: pointer; }
    .row.click:hover .label { text-decoration: underline; }
    .del { flex: 0 0 auto; cursor: pointer; border: none; background: transparent; color: var(--vscode-foreground); opacity: 0; padding: 0 2px; font-size: 12px; line-height: 1; }
    .row:hover .del { opacity: .65; }
    .del:hover { opacity: 1; color: var(--vscode-errorForeground, #f14c4c); }
    .muted { opacity: .6; font-size: 11px; }
    .empty { opacity: .6; font-size: 12px; font-style: italic; }
    
    /* Mini tabs for Plugins */
    .mini-tabs { display: flex; gap: 8px; }
    .mini-tab { font-size: 10px; padding: 2px 4px; cursor: pointer; opacity: .5; border-bottom: 1px solid transparent; text-transform: none; font-weight: normal; }
    .mini-tab:hover { opacity: 1; }
    .mini-tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div class="hero-title">AI StepFlow</div>
      <div class="hero-sub">Orchestrate Claude agents, skills & workflows.</div>
      <button class="action" id="open">Open Overview</button>
    </div>

    <div class="section">
      <div class="section-title">Active Run</div>
      <div class="card" id="active"><span class="empty">No active run</span></div>
    </div>

    <div class="section">
      <div class="section-title">Library</div>
      <div class="stats" id="stats"></div>
      <div class="library-actions" id="defaults"></div>
    </div>

    <div class="section">
      <div class="section-title">
        <span>Claude Plugins</span>
        <div class="mini-tabs" id="plugin-tabs">
          <div class="mini-tab active" data-tab="installed">Installed</div>
          <div class="mini-tab" data-tab="marketplace">Marketplace</div>
        </div>
      </div>
      <div class="card" id="plugins"><span class="muted">Checking…</span></div>
    </div>

    <div class="section">
      <div class="section-title">MCP Servers</div>
      <div class="card" id="mcp"><span class="muted">Checking…</span></div>
    </div>

    <div class="section">
      <div class="section-title">Generated Files <span class="muted" id="files-count"></span></div>
      <div class="card" id="files"><span class="empty">No runs yet</span></div>
    </div>

    <div class="footer">AI StepFlow${this.version ? ' · v' + this.version : ''}</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('open').onclick = () => vscode.postMessage({ type: 'openOverview' });

    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const fmtTime = iso => { const d = new Date(iso); return !isNaN(d.getTime()) ? d.toLocaleString() : esc(iso); };

    let activePluginTab = 'installed';
    let currentPlugins = [];
    const KNOWN_MARKETPLACE = ['web-search', 'figma', 'skill-creator', 'jira', 'slack', 'notion', 'google-drive', 'linear'];

    document.querySelectorAll('#plugin-tabs .mini-tab').forEach(n => {
      n.onclick = () => {
        document.querySelectorAll('#plugin-tabs .mini-tab').forEach(t => t.classList.remove('active'));
        n.classList.add('active');
        activePluginTab = n.getAttribute('data-tab');
        renderPlugins(currentPlugins);
      };
    });

    function renderActive(run) {
      const el = document.getElementById('active');
      if (!run) { el.innerHTML = '<span class="empty">No active run</span>'; return; }
      const step = run.currentStep
        ? '<div class="step-line"><span class="badge ' + esc(run.currentStep.status) + '">' + esc(run.currentStep.status) + '</span><span>' + esc(run.currentStep.title) + '</span></div>'
        : '';
      el.innerHTML =
        '<div class="run-head"><span class="run-flow">' + esc(run.flowName) + '</span>' +
        '<span class="run-sub">' + run.completed + '/' + run.total + ' steps</span></div>' +
        '<div class="bar"><span style="width:' + run.percent + '%"></span></div>' + step;
    }

    function renderStats(s) {
      const items = [['flows', s.flows, 'Workflows'], ['agents', s.agents, 'Agents'], ['skills', s.skills, 'Skills']];
      document.getElementById('stats').innerHTML = items.map(i =>
        '<div class="stat" data-tab="' + i[0] + '"><div class="num">' + i[1] + '</div><div class="lbl">' + i[2] + '</div></div>'
      ).join('');
      document.querySelectorAll('.stat').forEach(n => n.onclick = () => vscode.postMessage({ type: 'openOverview' }));
    }

    function renderDefaults(installed) {
      const el = document.getElementById('defaults');
      if (!installed) {
        el.innerHTML = '<button class="action" id="init-def">Install Professional Library</button>' +
          '<div class="muted" style="margin-top:6px">Adds professional SDLC agents & skills to ~/.claude or your project .claude folder.</div>';
        const btn = document.getElementById('init-def');
        if (btn) btn.onclick = () => vscode.postMessage({ type: 'installDefaults' });
      } else {
        el.innerHTML = '<div class="library-status">' +
          '<div class="library-status-main">' +
          '<span class="dot"></span>' +
          '<div class="library-status-copy">' +
          '<div class="library-status-title">Professional Library</div>' +
          '<div class="library-status-sub">Built-in agents and skills are installed.</div>' +
          '</div></div>' +
          '<button class="action secondary" id="reinit-def">Manage / Reinstall</button>' +
          '</div>';
        const btn = document.getElementById('reinit-def');
        if (btn) btn.onclick = () => vscode.postMessage({ type: 'installDefaults' });
      }
    }

    function renderMcp(list) {
      const el = document.getElementById('mcp');
      if (!list || !list.length) { el.innerHTML = '<span class="empty">None connected</span>'; return; }
      el.innerHTML = '<div class="list">' + list.map(name =>
        '<div class="row"><span class="dot"></span><span class="label">' + esc(name) + '</span></div>'
      ).join('') + '</div>';
    }

    function renderPlugins(list) {
      currentPlugins = list || [];
      const el = document.getElementById('plugins');
      
      if (activePluginTab === 'installed') {
        if (!list || !list.length) { el.innerHTML = '<span class="empty">No plugins installed</span>'; return; }
        el.innerHTML = '<div class="list">' + list.map(p =>
          '<div class="row">' +
          '<span class="dot" style="background:' + (p.enabled ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-red, #f14c4c)') + '"></span>' +
          '<span class="label" title="' + esc(p.version) + '">' + esc(p.name.split('@')[0]) + '</span>' +
          '<button class="del" style="opacity: .8" title="' + (p.enabled ? 'Disable' : 'Enable') + '" data-toggle="' + esc(p.name) + '" data-enable="' + !p.enabled + '">' +
          (p.enabled ? 'OFF' : 'ON') + '</button></div>'
        ).join('') + '</div>';
        el.querySelectorAll('button[data-toggle]').forEach(btn => {
          btn.onclick = () => vscode.postMessage({
            type: 'togglePlugin',
            pluginName: btn.getAttribute('data-toggle'),
            enable: btn.getAttribute('data-enable') === 'true'
          });
        });
      } else {
        const installedNames = new Set(list.map(p => p.name.split('@')[0].toLowerCase()));
        const available = KNOWN_MARKETPLACE.filter(name => !installedNames.has(name.toLowerCase()));

        if (!available.length) { el.innerHTML = '<span class="empty">All known plugins installed</span>'; return; }
        el.innerHTML = '<div class="list">' + available.map(name =>
          '<div class="row">' +
          '<span class="dot" style="background:var(--vscode-descriptionForeground); opacity:.3"></span>' +
          '<span class="label">' + esc(name) + '</span>' +
          '<button class="del" style="opacity: .8" title="Install" data-install="' + esc(name) + '">' +
          'INSTALL</button></div>'
        ).join('') + '</div>';
        el.querySelectorAll('button[data-install]').forEach(btn => {
          btn.onclick = () => vscode.postMessage({ type: 'installPlugin', pluginName: btn.getAttribute('data-install') });
        });
      }
    }

    function renderFiles(files, total) {
      document.getElementById('files-count').textContent = total ? '(' + total + ')' : '';
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

    window.addEventListener('message', e => {
      const m = e.data;
      if (m.type === 'data') {
        renderActive(m.activeRun);
        renderStats(m.stats);
        renderDefaults(m.defaultsInstalled);
        renderMcp(m.mcp);
        renderPlugins(m.plugins);
        renderFiles(m.runFiles, m.totalRunFiles);
      } else if (m.type === 'mcp') {
        renderMcp(m.mcp);
      } else if (m.type === 'plugins') {
        renderPlugins(m.plugins);
      }
    });
  </script>
</body>
</html>`;
  }
}
