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
    .wrap { padding: 14px 12px 18px; }

    /* Hero */
    .hero { display: flex; align-items: center; justify-content: center; gap: 7px; margin: 2px 0 14px; }
    .hero .logo { font-size: 17px; line-height: 1; }
    .hero .name { font-size: 14px; font-weight: 600; letter-spacing: .01em; }

    /* Buttons */
    button.action { width: 100%; cursor: pointer; border: none; border-radius: 5px; padding: 8px; font-size: 12px; font-weight: 500; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.action:hover { background: var(--vscode-button-hoverBackground); }
    button.action.secondary { color: var(--vscode-foreground); background: transparent; border: 1px solid var(--vscode-panel-border, var(--vscode-input-border)); font-weight: 400; margin-top: 8px; }
    button.action.secondary:hover { background: var(--vscode-list-hoverBackground); }

    /* Active run (always-visible when present) */
    .active { margin-top: 14px; padding: 10px 11px; border-radius: 6px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.06)); border: 1px solid var(--vscode-panel-border, var(--vscode-input-border)); }
    .active[hidden] { display: none; }
    .run-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .run-flow { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-sub { font-size: 11px; opacity: .7; flex: 0 0 auto; }
    .bar { height: 5px; border-radius: 3px; background: rgba(127,127,127,.22); overflow: hidden; margin: 8px 0 0; }
    .bar > span { display: block; height: 100%; background: var(--vscode-charts-blue, var(--vscode-focusBorder)); }
    .step-line { display: flex; align-items: center; gap: 6px; font-size: 11.5px; margin-top: 8px; opacity: .9; }
    .badge { font-size: 9.5px; padding: 1px 6px; border-radius: 8px; text-transform: uppercase; letter-spacing: .03em; background: rgba(127,127,127,.2); }
    .badge.running { background: var(--vscode-charts-blue, #3794ff); color: #fff; }
    .badge.completed { background: var(--vscode-charts-green, #2ea043); color: #fff; }

    /* Collapsible groups */
    .groups { margin-top: 12px; }
    details.group { border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,.18)); }
    details.group:last-of-type { border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,.18)); }
    details.group > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 7px; padding: 9px 2px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; opacity: .82; user-select: none; }
    details.group > summary::-webkit-details-marker { display: none; }
    details.group > summary::before { content: '\\203A'; display: inline-block; font-size: 13px; opacity: .55; transition: transform .12s ease; }
    details.group[open] > summary::before { transform: rotate(90deg); }
    details.group > summary:hover { opacity: 1; }
    .count { margin-left: auto; font-size: 10px; font-weight: 500; letter-spacing: 0; text-transform: none; opacity: .55; }
    .group-body { padding: 2px 2px 13px 18px; }

    /* Library stats */
    .stats { display: flex; gap: 6px; }
    .stat { flex: 1; text-align: center; border: 1px solid var(--vscode-panel-border, var(--vscode-input-border)); border-radius: 6px; padding: 7px 4px; cursor: pointer; }
    .stat:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
    .stat .num { font-size: 17px; font-weight: 600; }
    .stat .lbl { font-size: 9.5px; opacity: .65; text-transform: uppercase; letter-spacing: .04em; }
    .lib-status { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
    .lib-status-copy { min-width: 0; }
    .lib-status-title { font-size: 12px; font-weight: 600; }
    .lib-status-sub { font-size: 10.5px; opacity: .65; margin-top: 1px; }
    .help { font-size: 10.5px; opacity: .6; margin-top: 7px; line-height: 1.4; }

    /* Lists / rows */
    .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: 0 0 auto; background: var(--vscode-charts-green, #2ea043); }
    .list { display: flex; flex-direction: column; gap: 2px; }
    .row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 0; }
    .row .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row.click { cursor: pointer; }
    .row.click:hover .label { text-decoration: underline; }
    .del { flex: 0 0 auto; cursor: pointer; border: none; background: transparent; color: var(--vscode-foreground); opacity: 0; padding: 0 3px; font-size: 11px; line-height: 1; }
    .row:hover .del { opacity: .6; }
    .del:hover { opacity: 1; color: var(--vscode-errorForeground, #f14c4c); }
    .pill { flex: 0 0 auto; cursor: pointer; border: 1px solid var(--vscode-panel-border, var(--vscode-input-border)); background: transparent; color: var(--vscode-foreground); border-radius: 4px; font-size: 9.5px; letter-spacing: .03em; padding: 1px 6px; opacity: .85; }
    .pill:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }

    /* Plugin tabs */
    .mini-tabs { display: flex; gap: 12px; margin-bottom: 8px; }
    .mini-tab { font-size: 11px; cursor: pointer; opacity: .5; padding-bottom: 2px; border-bottom: 1.5px solid transparent; }
    .mini-tab:hover { opacity: .85; }
    .mini-tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }

    .muted { opacity: .6; font-size: 11px; }
    .empty { opacity: .55; font-size: 11.5px; font-style: italic; }
    footer { margin-top: 16px; font-size: 10px; opacity: .4; text-align: center; letter-spacing: .04em; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <span class="logo">🐇</span><span class="name">AI StepFlow</span>
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
        <div class="group-body"><div id="mcp"><span class="muted">Checking…</span></div></div>
      </details>

      <details class="group">
        <summary>Plugins<span class="count" id="plug-count"></span></summary>
        <div class="group-body">
          <div class="mini-tabs" id="plugin-tabs">
            <span class="mini-tab active" data-tab="installed">Installed</span>
            <span class="mini-tab" data-tab="marketplace">Marketplace</span>
          </div>
          <div id="plugins"><span class="muted">Checking…</span></div>
        </div>
      </details>

      <details class="group">
        <summary>Generated files<span class="count" id="files-count"></span></summary>
        <div class="group-body"><div id="files"><span class="empty">No runs yet</span></div></div>
      </details>
    </div>

    <footer>AI StepFlow${this.version ? ' · v' + this.version : ''}</footer>
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

    function renderMcp(list) {
      const el = document.getElementById('mcp');
      document.getElementById('conn-count').textContent = (list && list.length) ? String(list.length) : '';
      if (!list || !list.length) { el.innerHTML = '<span class="empty">None connected</span>'; return; }
      el.innerHTML = '<div class="list">' + list.map(name =>
        '<div class="row"><span class="dot"></span><span class="label">' + esc(name) + '</span></div>'
      ).join('') + '</div>';
    }

    function renderPlugins(list) {
      currentPlugins = list || [];
      const el = document.getElementById('plugins');
      document.getElementById('plug-count').textContent = (list && list.length) ? String(list.length) : '';

      if (activePluginTab === 'installed') {
        if (!list || !list.length) { el.innerHTML = '<span class="empty">No plugins installed</span>'; return; }
        el.innerHTML = '<div class="list">' + list.map(p =>
          '<div class="row">' +
          '<span class="dot" style="background:' + (p.enabled ? 'var(--vscode-charts-green)' : 'var(--vscode-charts-red, #f14c4c)') + '"></span>' +
          '<span class="label" title="' + esc(p.version) + '">' + esc(p.name.split('@')[0]) + '</span>' +
          '<button class="pill" title="' + (p.enabled ? 'Disable' : 'Enable') + '" data-toggle="' + esc(p.name) + '" data-enable="' + !p.enabled + '">' +
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
          '<button class="pill" title="Install" data-install="' + esc(name) + '">INSTALL</button></div>'
        ).join('') + '</div>';
        el.querySelectorAll('button[data-install]').forEach(btn => {
          btn.onclick = () => vscode.postMessage({ type: 'installPlugin', pluginName: btn.getAttribute('data-install') });
        });
      }
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
