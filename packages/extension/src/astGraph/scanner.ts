/**
 * `ast-graph scan` driver — runs the CLI, parses its summary, and exposes a debounced
 * file watcher so saves keep the graph fresh.
 *
 * DB layout: `<workspaceFolder>/.ast-graph/graph.db` (the CLI's default). We append
 * `.ast-graph/` to `.gitignore` to avoid committing the binary db.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, type ExecFileException } from 'child_process';

/** Watched source extensions — matches the languages ast-graph parses. */
const WATCH_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,cs,java,go}';
/** Directories we never re-scan on save (skip noise that would loop). */
const IGNORE_DIR_RE = /(^|[\\/])(node_modules|dist|out|build|target|\.next|\.git|\.ast-graph)([\\/]|$)/;

export interface ScanSummary {
  files: number;
  nodes: number;
  edges: number;
  languages: string[];
  durationMs: number;
  finishedAt: number;
  dbPath: string;
}

export function dbPathFor(folder: vscode.WorkspaceFolder): string {
  return path.join(folder.uri.fsPath, '.ast-graph', 'graph.db');
}

export async function ensureGitignoreEntry(folder: vscode.WorkspaceFolder): Promise<void> {
  const gi = path.join(folder.uri.fsPath, '.gitignore');
  let body = '';
  try {
    body = await fs.promises.readFile(gi, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  const lines = body.split(/\r?\n/);
  if (lines.some((l) => l.trim() === '.ast-graph/' || l.trim() === '.ast-graph')) return;

  // Only create a .gitignore when there's a .git folder — don't litter non-repo dirs.
  const hasGit = await fs.promises
    .stat(path.join(folder.uri.fsPath, '.git'))
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!hasGit && !body) return;

  const prefix = body && !body.endsWith('\n') ? '\n' : '';
  await fs.promises.writeFile(gi, `${body}${prefix}.ast-graph/\n`, 'utf8');
}

interface ScanOpts {
  binPath: string;
  folder: vscode.WorkspaceFolder;
  clean?: boolean;
  output: vscode.OutputChannel;
}

/** Run `ast-graph scan` once. Resolves with parsed stats on success; rejects with a readable Error. */
export async function runScan(opts: ScanOpts): Promise<ScanSummary> {
  const { binPath, folder, clean, output } = opts;
  const dbPath = dbPathFor(folder);
  // The CLI assumes the db's parent dir exists, so create it first.
  await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });

  const args = ['--db', dbPath, 'scan'];
  if (clean) args.push('--clean');
  args.push(folder.uri.fsPath);

  output.appendLine(`ast-graph: ${binPath} ${args.join(' ')}`);

  const started = Date.now();
  return new Promise<ScanSummary>((resolve, reject) => {
    execFile(
      binPath,
      args,
      { timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, cwd: folder.uri.fsPath },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - started;
        if (err) {
          const e = err as ExecFileException;
          if (e.code === 'ENOENT') {
            reject(new Error(`ast-graph binary not found at ${binPath}`));
            return;
          }
          const tail = (stderr || stdout || '').split(/\r?\n/).slice(-6).join('\n');
          reject(new Error(`ast-graph scan failed (exit ${e.code ?? 'n/a'}): ${tail.trim()}`));
          return;
        }
        const summary = parseSummary(stdout);
        if (!summary) {
          reject(new Error('ast-graph scan: could not parse summary. Tail: ' + stdout.split(/\r?\n/).slice(-4).join(' | ')));
          return;
        }
        resolve({ ...summary, durationMs, finishedAt: Date.now(), dbPath });
      },
    );
  });
}

/** Parse the "Graph Summary:" block emitted by `ast-graph scan`. */
function parseSummary(stdout: string): Omit<ScanSummary, 'durationMs' | 'finishedAt' | 'dbPath'> | null {
  const lines = stdout.split(/\r?\n/);
  let files = 0, nodes = 0, edges = 0;
  let langs: string[] = [];
  let inSummary = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('Graph Summary')) { inSummary = true; continue; }
    if (!inSummary) continue;
    const m = /^(\w+):\s+(.+)$/.exec(line);
    if (!m) continue;
    switch (m[1]) {
      case 'Files': files = parseInt(m[2], 10) || 0; break;
      case 'Nodes': nodes = parseInt(m[2], 10) || 0; break;
      case 'Edges': edges = parseInt(m[2], 10) || 0; break;
      case 'Languages':
        langs = m[2].replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
        break;
    }
  }
  if (!inSummary) return null;
  return { files, nodes, edges, languages: langs };
}

interface WatcherOpts {
  folder: vscode.WorkspaceFolder;
  debounceMs: number;
  onTrigger: () => void;
}

/** Create a debounced file watcher across the source languages ast-graph understands. */
export function createSourceWatcher(opts: WatcherOpts): vscode.Disposable {
  const pattern = new vscode.RelativePattern(opts.folder, WATCH_GLOB);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  let timer: NodeJS.Timeout | null = null;

  const fire = (uri: vscode.Uri) => {
    if (IGNORE_DIR_RE.test(uri.fsPath)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      opts.onTrigger();
    }, opts.debounceMs);
  };

  watcher.onDidChange(fire);
  watcher.onDidCreate(fire);
  watcher.onDidDelete(fire);

  return {
    dispose() {
      if (timer) clearTimeout(timer);
      watcher.dispose();
    },
  };
}
