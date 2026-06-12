/**
 * AST Graph integration orchestrator. Wires the binary downloader, the scanner, the MCP
 * registration, and a status-bar entry point into a single `registerAstGraph(context, output)`
 * call invoked from `extension.ts`.
 *
 * Lifecycle (all workspace folders — each `local` MCP scope points at that repo's db):
 *   1. Resolve binary (download + verify on first run, cache afterwards)
 *   2. Run initial scan
 *   3. Register MCP server with the Claude CLI (best-effort) + write the CLAUDE.md hint
 *   4. Start a debounced file watcher → incremental rescans on save
 *
 * Failures are surfaced via the status-bar pill rather than blocking notifications.
 */

import * as vscode from 'vscode';

import { ensureAstGraphBinary, UnsupportedPlatformError } from './binary.js';
import { createSourceWatcher, ensureLocalExcludeEntry, runScan, type ScanSummary } from './scanner.js';
import { reconcileMcpServer } from './mcpRegister.js';
import { ensureClaudeMdHint } from './claudeMdHint.js';

const SETTING_NAMESPACE = 'ai-stepflow.astGraph';
const RESCAN_CMD = 'ai-stepflow.astGraph.rescan';
const REREGISTER_CMD = 'ai-stepflow.astGraph.reregisterMcp';

interface FolderState {
  folder: vscode.WorkspaceFolder;
  lastScan: ScanSummary | null;
  scanning: boolean;
  mcp: { ok: boolean; reason: string };
  watcher: vscode.Disposable | null;
}

export function registerAstGraph(context: vscode.ExtensionContext, output: vscode.OutputChannel, onMcpReady?: () => void): void {
  const cfg = () => vscode.workspace.getConfiguration(SETTING_NAMESPACE);
  if (!cfg().get<boolean>('enabled', true)) {
    output.appendLine('AST graph: disabled via ai-stepflow.astGraph.enabled.');
    return;
  }

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  item.text = '$(type-hierarchy) AST …';
  item.tooltip = 'AST graph: preparing…';
  item.command = RESCAN_CMD;
  item.show();
  context.subscriptions.push(item);

  const folderStates = new Map<string, FolderState>();
  let binPath: string | null = null;

  const workspaceFolders = (): readonly vscode.WorkspaceFolder[] => vscode.workspace.workspaceFolders ?? [];
  const stateFor = (folder: vscode.WorkspaceFolder): FolderState => {
    const key = folder.uri.toString();
    const existing = folderStates.get(key);
    if (existing) return existing;
    const created: FolderState = {
      folder, lastScan: null, scanning: false, mcp: { ok: false, reason: 'not registered yet' }, watcher: null,
    };
    folderStates.set(key, created);
    return created;
  };

  const updateStatusBar = (): void => {
    if (!binPath) {
      item.text = '$(cloud-download) AST …';
      item.tooltip = 'AST graph: downloading binary…';
      return;
    }
    const folders = workspaceFolders();
    if (!folders.length) {
      item.text = '$(type-hierarchy) AST';
      item.tooltip = 'AST graph: no workspace folder.';
      return;
    }
    const states = folders.map(stateFor);
    const connected = states.filter((s) => s.mcp.ok).length;
    const scanning = states.filter((s) => s.scanning).length;
    const scanned = states.filter((s) => s.lastScan).length;
    item.text = scanning
      ? `$(sync~spin) AST ${connected}/${folders.length}`
      : `$(type-hierarchy) AST ${connected}/${folders.length}`;

    const md = new vscode.MarkdownString();
    md.appendMarkdown('**AST graph**\n\n');
    for (const s of states) {
      const scan = s.scanning
        ? 'scanning'
        : s.lastScan
          ? `${s.lastScan.files} files · ${s.lastScan.nodes} nodes`
          : 'not scanned';
      const mcp = s.mcp.ok ? 'connected' : `off (${s.mcp.reason || 'not registered'})`;
      md.appendMarkdown(`- **${s.folder.name}**: ${scan}; MCP ${mcp}\n`);
    }
    md.appendMarkdown(`\nScanned: ${scanned}/${folders.length}. Click to rescan.`);
    item.tooltip = md;
  };

  async function scanFolder(folder: vscode.WorkspaceFolder, clean: boolean): Promise<void> {
    if (!binPath) {
      output.appendLine('AST graph: binary not ready, scan skipped.');
      return;
    }
    const key = folder.uri.toString();
    const state = stateFor(folder);
    if (state.scanning) {
      output.appendLine(`AST graph: scan already in flight for ${folder.name}, skipping.`);
      return;
    }
    state.scanning = true;
    folderStates.set(key, state);
    updateStatusBar();

    try {
      await ensureLocalExcludeEntry(folder);
      const summary = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `ast-graph scan: ${folder.name}` },
        () => runScan({ binPath: binPath!, folder, clean, output }),
      );
      state.lastScan = summary;
      output.appendLine(`AST graph [${folder.name}]: scan done — ${summary.files} files, ${summary.nodes} nodes, ${summary.edges} edges in ${summary.durationMs}ms.`);
      await registerMcp(folder);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`AST graph [${folder.name}]: scan failed — ${msg}`);
      void vscode.window.showWarningMessage(`AST graph scan failed for ${folder.name}: ${msg}`);
    } finally {
      state.scanning = false;
      folderStates.set(key, state);
      updateStatusBar();
    }
  }

  async function registerMcp(folder: vscode.WorkspaceFolder): Promise<void> {
    if (!binPath) return;
    const key = folder.uri.toString();
    const state = folderStates.get(key);
    if (!state || !state.lastScan) return;

    const result = await reconcileMcpServer({ binPath, dbPath: state.lastScan.dbPath, cwd: folder.uri.fsPath });
    state.mcp = result;
    folderStates.set(key, state);
    if (result.ok) {
      output.appendLine(`AST graph [${folder.name}]: MCP connected.`);
      await writeHint(folder);
      onMcpReady?.();
    } else {
      output.appendLine(`AST graph [${folder.name}]: MCP registration failed/skipped — ${result.reason}`);
    }
    updateStatusBar();
  }

  async function writeHint(folder: vscode.WorkspaceFolder): Promise<void> {
    try {
      const hintPath = await ensureClaudeMdHint(folder);
      output.appendLine(`AST graph: CLAUDE.md hint ensured at ${hintPath}`);
    } catch (err) {
      output.appendLine(`AST graph: failed to write CLAUDE.md hint — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function attachWatcher(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    const state = folderStates.get(key);
    if (!state || state.watcher) return;
    const debounceMs = Math.max(1, cfg().get<number>('autoRescanDebounceSeconds', 5)) * 1000;
    state.watcher = createSourceWatcher({
      folder,
      debounceMs,
      onTrigger: () => void scanFolder(folder, false),
    });
    folderStates.set(key, state);
    context.subscriptions.push(state.watcher);
  }

  async function runForFolders(folders: readonly vscode.WorkspaceFolder[], clean: boolean): Promise<void> {
    if (!folders.length) {
      output.appendLine('AST graph: no workspace folder open, deferring scan.');
      return;
    }
    for (const folder of folders) {
      await scanFolder(folder, clean);
      if (folderStates.get(folder.uri.toString())?.lastScan) {
        attachWatcher(folder);
      }
    }
  }

  async function pickFoldersForCommand(title: string): Promise<readonly vscode.WorkspaceFolder[] | undefined> {
    const folders = workspaceFolders();
    if (folders.length <= 1) return folders;
    const all = { label: '$(repo) All workspace repos', description: `${folders.length} repos`, folders };
    const picked = await vscode.window.showQuickPick(
      [
        all,
        ...folders.map((folder) => ({
          label: `$(folder) ${folder.name}`,
          description: folder.uri.fsPath,
          folders: [folder] as readonly vscode.WorkspaceFolder[],
        })),
      ],
      { title, placeHolder: 'Choose which repo AST graph should update' },
    );
    return picked?.folders;
  }

  function disposeFolder(folder: vscode.WorkspaceFolder): void {
    const key = folder.uri.toString();
    const state = folderStates.get(key);
    state?.watcher?.dispose();
    folderStates.delete(key);
  }

  async function reregisterFolders(folders: readonly vscode.WorkspaceFolder[]): Promise<void> {
    if (!binPath) return;
    for (const folder of folders) {
      const state = stateFor(folder);
      if (!state.lastScan) {
        await scanFolder(folder, false);
        continue;
      }
      await registerMcp(folder);
    }
  }

  async function bootstrap(): Promise<void> {
    try {
      const overridePath = cfg().get<string>('binaryPath', '').trim();
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Preparing AST graph CLI…' },
        () => ensureAstGraphBinary(context, output, overridePath),
      );
      binPath = res.path;
      output.appendLine(`AST graph: binary ready (v${res.version}) at ${res.path}`);
    } catch (err) {
      if (err instanceof UnsupportedPlatformError) {
        output.appendLine(`AST graph: ${err.message} Set ai-stepflow.astGraph.binaryPath to a locally-installed ast-graph executable to use it anyway.`);
      } else {
        output.appendLine(`AST graph: binary install failed — ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showWarningMessage(`AST graph: failed to install the bundled CLI. ${err instanceof Error ? err.message : String(err)}`);
      }
      updateStatusBar();
      return;
    }
    updateStatusBar();
    await runForFolders(workspaceFolders(), false);
  }

  void bootstrap();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      for (const folder of event.removed) disposeFolder(folder);
      if (binPath && event.added.length) await runForFolders(event.added, false);
      updateStatusBar();
    }),
    vscode.commands.registerCommand(RESCAN_CMD, async () => {
      const folders = await pickFoldersForCommand('Rescan AST Graph');
      if (folders) await runForFolders(folders, true);
    }),
    vscode.commands.registerCommand(REREGISTER_CMD, async () => {
      const folders = await pickFoldersForCommand('Re-register AST Graph MCP Server');
      if (folders) await reregisterFolders(folders);
      updateStatusBar();
    }),
  );

  output.appendLine('AST graph: integration registered.');
}
