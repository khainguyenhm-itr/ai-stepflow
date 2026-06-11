import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ConfigManager } from './configManager.js';
import { StateManager } from './stateManager.js';
import { TerminalManager } from './terminalManager.js';
import { RunOrchestrator } from './runOrchestrator.js';
import { validateMessage, WebviewMessage, HostMessage } from './messages.js';
import { listConnectedMcpServers, addMcpServer } from './mcp.js';
import { Agent, Skill } from '@ai-stepflow/core';

export class CockpitPanel {
  public static currentPanel: CockpitPanel | undefined;
  private static readonly viewType = 'aiStepFlowCockpit';
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  /** Owns the interactive `claude` terminal for ad-hoc and non-headless step runs. */
  private readonly _terminals: TerminalManager;
  /** Owns the run state machine and every transition that drives a flow run. */
  private readonly _runner: RunOrchestrator;

  public static createOrShow(
    extensionUri: vscode.Uri,
    configManager: ConfigManager,
    stateManager: StateManager
  ) {
    if (CockpitPanel.currentPanel) {
      CockpitPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CockpitPanel.viewType,
      'AI StepFlow',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'out/webview')
        ]
      }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources/icon.svg');

    CockpitPanel.currentPanel = new CockpitPanel(panel, extensionUri, configManager, stateManager);
  }

  public static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    configManager: ConfigManager,
    stateManager: StateManager
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out/webview')]
    };
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources/icon.svg');
    CockpitPanel.currentPanel = new CockpitPanel(panel, extensionUri, configManager, stateManager);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private configManager: ConfigManager,
    private stateManager: StateManager
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._terminals = new TerminalManager(configManager);
    this._runner = new RunOrchestrator(configManager, stateManager, this._terminals, msg => this.postMessage(msg));

    this._update();
    // Send data immediately and also on 'ready' handshake
    void this._sendAllData();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      message => this._handleMessage(message).catch(error => {
        const text = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`AI StepFlow: ${text}`);
      }),
      null,
      this._disposables
    );
  }

  private async _handleMessage(raw: unknown): Promise<void> {
    const message = validateMessage(raw);
    if (!message) return;
    await this._dispatch(message);
  }

  private async _dispatch(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this._sendAllData();
        await this._runner.restore();
        return;
      case 'loadFlow':
        this._runner.setFlowAndRunState(message.flow, message.runState);
        return;
      case 'openFile':
        await this._handleOpenFile(message.path);
        return;
      case 'saveFlow': {
        const isGlobal = typeof message.isGlobal === 'boolean'
          ? message.isGlobal
          : this.configManager.isGlobalSourcePath(message.flow.sourcePath);
        await this.configManager.saveFlow(message.flow, isGlobal);
        await this._sendAllData();
        vscode.window.showInformationMessage(`Flow '${message.flow.name}' saved.`);
        return;
      }
      case 'createAgent':
        await this.configManager.saveAgent(message.agent, !!message.isGlobal);
        await this._sendAllData();
        vscode.window.showInformationMessage(`Agent '${message.agent.name}' created.`);
        return;
      case 'updateAgent': {
        const newPath = await this.configManager.saveAgent(message.agent, !!message.isGlobal);
        if (message.originalSourcePath && path.normalize(message.originalSourcePath) !== path.normalize(newPath)) {
          await this.configManager.deleteAgent(message.originalSourcePath);
        }
        await this._sendAllData();
        vscode.window.showInformationMessage(`Agent '${message.agent.name}' updated.`);
        return;
      }
      case 'createSkill':
        await this.configManager.saveSkill(message.skill, !!message.isGlobal);
        await this._sendAllData();
        vscode.window.showInformationMessage(`Skill '${message.skill.name}' created.`);
        return;
      case 'updateSkill': {
        const newPath = await this.configManager.saveSkill(message.skill, !!message.isGlobal);
        if (message.originalSourcePath && path.normalize(message.originalSourcePath) !== path.normalize(newPath)) {
          await this.configManager.deleteSkill(message.originalSourcePath);
        }
        await this._sendAllData();
        vscode.window.showInformationMessage(`Skill '${message.skill.name}' updated.`);
        return;
      }
      case 'deleteFlow': {
        const choice = await vscode.window.showWarningMessage(
          `Delete flow '${message.flow.name}'? This removes ${message.flow.sourcePath}.`,
          { modal: true },
          'Delete'
        );
        if (choice !== 'Delete') return;
        await this.configManager.deleteFlow(message.flow.sourcePath);
        this._runner.clearIfFlow(message.flow.id);
        await this._sendAllData();
        vscode.window.showInformationMessage(`Flow '${message.flow.name}' deleted.`);
        return;
      }
      case 'deleteAgent': {
        const choice = await vscode.window.showWarningMessage(
          `Delete agent '${message.agent.name}'? This removes ${message.agent.sourcePath}.`,
          { modal: true },
          'Delete'
        );
        if (choice !== 'Delete') return;
        await this.configManager.deleteAgent(message.agent.sourcePath);
        await this._sendAllData();
        vscode.window.showInformationMessage(`Agent '${message.agent.name}' deleted.`);
        return;
      }
      case 'deleteSkill': {
        const choice = await vscode.window.showWarningMessage(
          `Delete skill '${message.skill.name}'? This removes its skill file and any bundled resources.`,
          { modal: true },
          'Delete'
        );
        if (choice !== 'Delete') return;
        await this.configManager.deleteSkill(message.skill.sourcePath);
        await this._sendAllData();
        vscode.window.showInformationMessage(`Skill '${message.skill.name}' deleted.`);
        return;
      }
      case 'updateRunState':
        await this._runner.adoptRunState(message.runState, message.historyEvent);
        return;
      case 'runStep':
        await this._runner.runStep(message.stepId, { flow: message.flow, runState: message.runState, description: message.description });
        return;
      case 'cancelStep':
        this._runner.cancelStep(message.stepId);
        return;
      case 'runAgent':
        await this._handleRunAgent(message.agent, message.description);
        return;
      case 'runSkill':
        await this._handleRunSkill(message.skill, message.description);
        return;
      case 'submitHumanReview':
        this._runner.submitHumanReview(message.stepId, message.review);
        return;
      case 'markStepDone':
        await this._runner.markStepDone(message.stepId);
        return;
      case 'verifyRun':
        await this._runner.verify();
        return;
      case 'exportRunReport':
        await this._runner.exportReport();
        return;
      case 'importAgentFile':
        await this._handleImportFile('agent');
        return;
      case 'importSkillFile':
        await this._handleImportFile('skill');
        return;
      case 'generateDraft':
        await this._handleGenerateDraft(message.kind, message.name, message.description);
        return;
      case 'connectMcpServer':
        try {
          const res = await addMcpServer({
            ...message.config,
            cwd: this.configManager.getProjectPath()
          });
          if (res.ok) {
            vscode.window.showInformationMessage(`AI StepFlow: MCP server '${message.config.name}' connected.`);
            const connectedMcpServers = await listConnectedMcpServers(this.configManager.getProjectPath());
            this.postMessage({ type: 'mcpServers', connectedMcpServers });
          } else {
            vscode.window.showErrorMessage(`AI StepFlow: failed to connect MCP server. ${res.error}`);
          }
        } catch (e) {
          vscode.window.showErrorMessage(`AI StepFlow: failed to connect MCP server. ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      case 'alert':
        vscode.window.showErrorMessage(message.text);
        return;
    }
  }

  private async _handleImportFile(kind: 'agent' | 'skill'): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: `Import ${kind}`,
      filters: { Markdown: ['md'] }
    });
    const fileUri = picked?.[0];
    if (!fileUri) return;

    if (kind === 'agent') {
      const agent = await this.configManager.importAgentFromFile(fileUri.fsPath);
      if (agent) {
        this.postMessage({ type: 'fileImported', kind, item: { name: agent.name, description: agent.description, model: agent.model, tools: agent.tools?.join(', ') ?? '', systemPrompt: agent.systemPrompt } });
      }
    } else {
      const skill = await this.configManager.importSkillFromFile(fileUri.fsPath);
      if (skill) {
        this.postMessage({ type: 'fileImported', kind, item: { name: skill.name, description: skill.description, instructions: skill.instructions } });
      }
    }
  }

  private async _handleGenerateDraft(kind: 'agent' | 'skill', name: string, description?: string): Promise<void> {
    const target = kind === 'agent' ? 'a system prompt for a Claude Code subagent' : 'the instruction body for a reusable Claude Code skill';
    const metaPrompt = [`Write ${target}.`, `Name: ${name}`, description?.trim() ? `Purpose: ${description.trim()}` : '', '', 'Rules:', '- Return ONLY markdown.', '- Be concise.'].join('\n');
    const projectPath = this.configManager.getProjectPath() || '';

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Drafting ${kind}...` }, async () => {
      let text = '';
      const result = await this._runner.spawnClaudeStreaming({ systemPrompt: '', userMessage: metaPrompt, projectPath, onText: chunk => { text += chunk; } });
      if (!result.success) {
        const why = result.timedOut ? 'run timed out' : `claude exited ${result.exitCode}`;
        console.error('AI StepFlow: draft generation failed —', why);
        this.postMessage({ type: 'draftGenerated', kind, error: why });
        return;
      }
      this.postMessage({ type: 'draftGenerated', kind, content: (result.resultText || text).trim() });
    });
  }

  public async refreshData(): Promise<void> {
    await this._sendAllData();
  }

  private async _sendAllData() {
    try {
      console.log('AI StepFlow: fetching data from ConfigManager...');
      const [flows, agents, skills] = await Promise.all([
        this.configManager.loadFlows().catch(e => { console.error('AI StepFlow: loadFlows failed', e); return []; }),
        this.configManager.loadAgents().catch(e => { console.error('AI StepFlow: loadAgents failed', e); return []; }),
        this.configManager.loadSkills().catch(e => { console.error('AI StepFlow: loadSkills failed', e); return []; })
      ]);
      console.log(`AI StepFlow: loaded ${flows.length} flows, ${agents.length} agents, ${skills.length} skills.`);

      const auditLogs: Record<string, any[]> = {};
      await Promise.all(flows.map(async flow => {
        try {
          auditLogs[flow.id] = await this.stateManager.loadAuditLog(flow.id);
        } catch (e) {
          auditLogs[flow.id] = [];
        }
      }));

      const projectPath = this.configManager.getProjectPath() || '';
      const globalPath = this.configManager.getGlobalPath() || '';

      console.log('AI StepFlow: posting loadData message to webview...');
      this.postMessage({
        type: 'loadData',
        flows, agents, skills,
        connectedMcpServers: [],
        auditLogs,
        globalPath,
        projectPath
      });

      if (projectPath) {
        void listConnectedMcpServers(projectPath).then(connectedMcpServers => {
          this.postMessage({ type: 'mcpServers', connectedMcpServers });
        }).catch(err => {
          console.error('AI StepFlow: MCP probe failed', err);
        });
      }
    } catch (err) {
      console.error('AI StepFlow: _sendAllData critical failure', err);
      this.postMessage({
        type: 'loadData',
        flows: [], agents: [], skills: [],
        connectedMcpServers: [],
        auditLogs: {},
        globalPath: '',
        projectPath: ''
      });
    }
  }

  private async _handleOpenFile(filePath: string | undefined) {
    if (!filePath) return;
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.configManager.getProjectPath() || '', filePath);
    if (!fs.existsSync(absPath)) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async _handleRunAgent(agent: Agent | undefined, description?: string) {
    if (agent) await this._terminals.runInTerminal(description?.trim() || '', this.configManager.getProjectPath() || '', agent);
  }

  private async _handleRunSkill(skill: Skill | undefined, description?: string) {
    if (skill) await this._terminals.runInTerminal(this._buildCommandPrompt(skill.name, description), this.configManager.getProjectPath() || '');
  }

  private _buildCommandPrompt(commandName: string, description?: string): string {
    return description?.trim() ? `/${commandName} ${description.trim()}` : `/${commandName}`;
  }

  public dispose() {
    CockpitPanel.currentPanel = undefined;
    this._runner.dispose();
    this._terminals.dispose();
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) x.dispose();
    }
  }

  private _update() { this._panel.webview.html = this._getHtmlForWebview(this._panel.webview); }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out/webview', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out/webview', 'main.css'));
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');
    
    let html = fs.readFileSync(path.join(this._extensionUri.fsPath, 'out/webview/index.html'), 'utf8');
    html = html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);
    html = html.replace('href="main.css"', `href="${styleUri}"`);
    html = html.replace('src="main.js"', `nonce="${nonce}" src="${scriptUri}"`);
    return html;
  }

  public postMessage(message: HostMessage) {
    if (!this._panel.webview) return;
    this._panel.webview.postMessage(message);
  }
}
