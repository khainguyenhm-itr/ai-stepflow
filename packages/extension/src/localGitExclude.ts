/**
 * Keep the directories this extension writes into out of git, locally.
 *
 * `.claude/` (library) and `.claudesteps/` (run state, artifacts) are per-machine working data,
 * so they go into `.git/info/exclude` rather than the shared `.gitignore` — a repo's own ignore
 * rules are the team's decision, not ours.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** Directories appended to `.git/info/exclude`, each only when it is not already listed. */
const EXCLUDED_DIRS = ['.claude/', '.claudesteps/'];

/** Append the missing exclude entries for `folder`. No-op outside a git repo; never throws. */
export async function ensureLocalExcludeEntry(folder: vscode.WorkspaceFolder): Promise<void> {
  const gitDir = path.join(folder.uri.fsPath, '.git');
  const hasGit = await fs.promises
    .stat(gitDir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!hasGit) return;

  const exclude = path.join(gitDir, 'info', 'exclude');
  let body = '';
  try {
    body = await fs.promises.readFile(exclude, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
    await fs.promises.mkdir(path.dirname(exclude), { recursive: true });
  }
  const lines = body.split(/\r?\n/);
  const entries = EXCLUDED_DIRS.filter(dir => {
    const bare = dir.replace(/\/$/, '');
    return !lines.some((l) => l.trim() === dir || l.trim() === bare);
  });
  if (!entries.length) return;

  const prefix = body && !body.endsWith('\n') ? '\n' : '';
  await fs.promises.writeFile(exclude, `${body}${prefix}${entries.join('\n')}\n`, 'utf8');
}
