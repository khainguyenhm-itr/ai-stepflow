/**
 * AST Graph integration orchestrator. Wires the binary downloader, the scanner, the MCP
 * registration, and a status-bar entry point into a single `registerAstGraph(context, output)`
 * call invoked from `extension.ts`.
 *
 * Lifecycle (primary workspace folder only — `local` MCP scope points at one db):
 *   1. Resolve binary (download + verify on first run, cache afterwards)
 *   2. Run initial scan
 *   3. Register MCP server with the Claude CLI (best-effort) + write the CLAUDE.md hint
 *   4. Start a debounced file watcher → incremental rescans on save
 *
 * Failures are surfaced via the status-bar pill rather than blocking notifications.
 */

import * as vscode from 'vscode';

import { ensureAstGraphBinary, UnsupportedPlatformError } from './binary.js';
import { createSourceWatcher, ensureGitignoreEntry, runScan, type ScanSummary } from './scanner.js';
import { isAlreadyRegistered, registerMcpServer } from './mcpRegister.js';
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

export function registerAstGraph(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
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

  const primaryFolder = (): vscode.WorkspaceFolder | undefined => vscode.workspace.workspaceFolders?.[0];
  const primaryState = (): FolderState | undefined => {
    const f = primaryFolder();
    return f ? folderStates.get(f.uri.toString()) : undefined;
  };

  const updateStatusBar = (): void => {
    const s = primaryState();
    if (!binPath) {
      item.text = '$(cloud-download) AST …';
      item.tooltip = 'AST graph: downloading binary…';
      return;
    }
    if (!s) {
      item.text = '$(type-hierarchy) AST';
      item.tooltip = 'AST graph: no workspace folder.';
      return;
    }
    if (s.scanning) {
      item.text = '$(sync~spin) AST';
      item.tooltip = 'AST graph: scanning…';
      return;
    }
    if (s.lastScan) {
      const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
      item.text = `$(type-hierarchy) AST ${k(s.lastScan.nodes)}n`;
      const md = new vscode.MarkdownString();
      md.appendMarkdown('**AST graph**\n\n');
      md.appendMarkdown(`Files: ${s.lastScan.files} · Nodes: ${s.lastScan.nodes} · Edges: ${s.lastScan.edges}\n\n`);
      md.appendMarkdown(`Languages: ${s.lastScan.languages.join(', ') || '—'}\n\n`);
      md.appendMarkdown(`MCP: ${s.mcp.ok ? 'registered' : `off (${s.mcp.reason || 'not registered'})`}\n\n`);
      md.appendMarkdown('Click to rescan.');
      item.tooltip = md;
    } else {
      item.text = '$(type-hierarchy) AST';
      item.tooltip = 'AST graph: no scan yet. Click to scan.';
    }
  };

  async function scanFolder(folder: vscode.WorkspaceFolder, clean: boolean): Promise<void> {
    if (!binPath) {
      output.appendLine('AST graph: binary not ready, scan skipped.');
      return;
    }
    const key = folder.uri.toString();
    const state: FolderState = folderStates.get(key) ?? {
      folder, lastScan: null, scanning: false, mcp: { ok: false, reason: 'not registered yet' }, watcher: null,
    };
    if (state.scanning) {
      output.appendLine(`AST graph: scan already in flight for ${folder.name}, skipping.`);
      return;
    }
    state.scanning = true;
    folderStates.set(key, state);
    updateStatusBar();

    try {
      await ensureGitignoreEntry(folder);
      const summary = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `ast-graph scan: ${folder.name}` },
        () => runScan({ binPath: binPath!, folder, clean, output }),
      );
      state.lastScan = summary;
      output.appendLine(`AST graph: scan done — ${summary.files} files, ${summary.nodes} nodes, ${summary.edges} edges in ${summary.durationMs}ms.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`AST graph: scan failed — ${msg}`);
      void vscode.window.showWarningMessage(`AST graph scan failed: ${msg}`);
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

    const already = await isAlreadyRegistered(folder.uri.fsPath);
    if (already) {
      state.mcp = { ok: true, reason: 'already registered' };
      folderStates.set(key, state);
      output.appendLine(`AST graph: MCP already registered in ${folder.name}.`);
      await writeHint(folder);
      updateStatusBar();
      return;
    }
    const result = await registerMcpServer({ binPath, dbPath: state.lastScan.dbPath, cwd: folder.uri.fsPath });
    state.mcp = result;
    folderStates.set(key, state);
    if (result.ok) {
      output.appendLine(`AST graph: registered MCP server in ${folder.name}.`);
      await writeHint(folder);
    } else {
      output.appendLine(`AST graph: MCP registration skipped — ${result.reason}`);
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
    state.watcher = createSourceWatcher({ folder, debounceMs, onTrigger: () => void scanFolder(folder, false) });
    folderStates.set(key, state);
    context.subscriptions.push(state.watcher);
  }

  async function runForPrimary(clean: boolean): Promise<void> {
    const f = primaryFolder();
    if (!f) {
      output.appendLine('AST graph: no workspace folder open, deferring scan.');
      return;
    }
    await scanFolder(f, clean);
    if (folderStates.get(f.uri.toString())?.lastScan) {
      await registerMcp(f);
      attachWatcher(f);
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
    await runForPrimary(false);
  }

  void bootstrap();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      if (binPath && !primaryState()?.lastScan) await runForPrimary(false);
      updateStatusBar();
    }),
    vscode.commands.registerCommand(RESCAN_CMD, () => runForPrimary(true)),
    vscode.commands.registerCommand(REREGISTER_CMD, async () => {
      const f = primaryFolder();
      const s = primaryState();
      if (!binPath || !f || !s?.lastScan) return;
      const res = await registerMcpServer({ binPath, dbPath: s.lastScan.dbPath, cwd: f.uri.fsPath });
      s.mcp = res;
      folderStates.set(f.uri.toString(), s);
      if (res.ok) await writeHint(f);
      updateStatusBar();
    }),
  );

  output.appendLine('AST graph: integration registered.');
}
