import * as vscode from 'vscode';
import { ConfigManager } from './configManager.js';
import { CockpitPanel } from './webviewPanel.js';
import { StateManager } from './stateManager.js';
import { SidebarProvider } from './sidebarProvider.js';
import { registerAstGraph } from './astGraph/index.js';

export function activate(context: vscode.ExtensionContext) {
  try {
    // Use extensionUri for better path handling in modern VSCode
    const configManager = new ConfigManager(context.extensionUri.fsPath);
    const stateManager = new StateManager(context);
    const output = vscode.window.createOutputChannel('AI StepFlow');

    // Sidebar dashboard: active run, library counts, MCP servers, generated files.
    // Defensively handle version access
    const version = String(context.extension?.packageJSON?.version || '0.0.7');
    const sidebar = new SidebarProvider(context.extensionUri, configManager, stateManager, version);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar)
    );

    const refreshAll = () => {
      void CockpitPanel.currentPanel?.refreshData();
      void sidebar.refresh(false);
    };

    // The cockpit can also be opened from the status bar.
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(rocket) AI StepFlow';
    statusBarItem.tooltip = 'Open Overview';
    statusBarItem.command = 'ai-stepflow.openOverview';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Auto-refresh when agents/skills/flows change on disk (global and project scope).
    const watchRoot = (rootUri: vscode.Uri) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(rootUri, '{agents,skills,flows}/**')
      );
      watcher.onDidCreate(refreshAll);
      watcher.onDidChange(refreshAll);
      watcher.onDidDelete(refreshAll);
      context.subscriptions.push(watcher);
    };

    watchRoot(vscode.Uri.file(configManager.getGlobalPath()));
    const projectPath = configManager.getProjectPath();
    if (projectPath) {
      watchRoot(vscode.Uri.joinPath(vscode.Uri.file(projectPath), '.claude'));

      // Run files are rewritten on every step event, so watching them keeps the
      // sidebar's active-run and generated-files sections live as a run progresses.
      const runsWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.joinPath(vscode.Uri.file(projectPath), '.claude-flow', 'runs'), '**')
      );
      const refreshSidebar = () => void sidebar.refresh(false);
      runsWatcher.onDidCreate(refreshSidebar);
      runsWatcher.onDidChange(refreshSidebar);
      runsWatcher.onDidDelete(refreshSidebar);
      context.subscriptions.push(runsWatcher);
    }

    // Re-attach the cockpit after a window reload instead of showing a dead panel.
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer('aiStepFlowCockpit', {
        async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
          CockpitPanel.revive(panel, context.extensionUri, configManager, stateManager);
        }
      })
    );

    // Commands
    context.subscriptions.push(
      vscode.commands.registerCommand('ai-stepflow.openOverview', () => {
        CockpitPanel.createOrShow(context.extensionUri, configManager, stateManager);
      }),
      vscode.commands.registerCommand('ai-stepflow.refreshAll', refreshAll),
      output,
      vscode.commands.registerCommand('ai-stepflow.installDefaults', async () => {
        const items: (vscode.QuickPickItem & { scope: 'global' | 'project' })[] = [
          { label: '$(globe) Global', description: 'Install to ~/.claude (available across all projects)', scope: 'global' },
        ];
        if (configManager.projectPath) {
          items.push({ label: '$(repo) Current Repo', description: 'Install to .claude in this workspace', scope: 'project' });
        }

        const picked = await vscode.window.showQuickPick(items, {
          title: 'Install Default Agent & Skill Library',
          placeHolder: 'Select where to install the professional SDLC library'
        });

        if (!picked) return;

        const isGlobal = picked.scope === 'global';
        await configManager.installDefaultLibrary(isGlobal);

        vscode.window.showInformationMessage(
          `AI StepFlow: default agents & skills installed to ${isGlobal ? 'global (~/.claude)' : 'current repo (.claude)'}.`
        );
        refreshAll();
      }),

    );

    // AST graph: download the CLI, index the workspace, register it as a project-scoped MCP
    // server, and drop a CLAUDE.md hint so step runs answer structural questions cheaply
    // (one MCP query vs a grep+read sweep). Best-effort; never blocks activation.
    registerAstGraph(context, output);
  } catch (err) {
    console.error('AI StepFlow: activation failed', err);
    vscode.window.showErrorMessage(`AI StepFlow: activation failed. ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function deactivate() {}
