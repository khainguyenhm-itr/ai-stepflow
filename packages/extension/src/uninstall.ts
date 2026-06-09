/**
 * Runs (via the `vscode:uninstall` package.json script) when the extension is removed.
 * Cleans up everything this extension wrote outside its own folder:
 *   - default agent/skill files in ~/.claude (identified by the built-in marker)
 *   - the Karpathy block merged into each project CLAUDE.md (identified by start/end markers,
 *     using the path list we recorded at merge time, since no workspace context exists here)
 * Plain Node only: no `vscode` API, so marker strings are duplicated rather than imported.
 */
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

const MARKER = 'ai-stepflow built-in';
const CLAUDE_MD_START = '<!-- ai-stepflow:karpathy:start -->';
const CLAUDE_MD_END = '<!-- ai-stepflow:karpathy:end -->';
const root = path.join(os.homedir(), '.claude');

async function removeMarkedEntries(dir: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // dir absent — nothing installed here
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    try {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const content = await fs.readFile(target, 'utf8');
        if (content.includes(MARKER)) await fs.rm(target, { force: true });
      } else if (entry.isDirectory()) {
        // Folder-based skills keep their metadata in SKILL.md (e.g. an older karpathy skill).
        const skillFile = path.join(target, 'SKILL.md');
        const content = await fs.readFile(skillFile, 'utf8').catch(() => undefined);
        if (content && content.includes(MARKER)) await fs.rm(target, { recursive: true, force: true });
      }
    } catch {
      /* leave anything we cannot read or remove */
    }
  }
}

/** Strip the marked Karpathy block (and any surrounding blank lines) from every recorded CLAUDE.md. */
async function stripClaudeMdBlocks(): Promise<void> {
  const trackPath = path.join(root, '.ai-stepflow', 'claude-md-paths.json');
  let paths: string[];
  try {
    paths = JSON.parse(await fs.readFile(trackPath, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(paths)) return;

  const blockPattern = new RegExp(
    `\\n*${escapeRegExp(CLAUDE_MD_START)}[\\s\\S]*?${escapeRegExp(CLAUDE_MD_END)}\\n*`,
    'g'
  );
  for (const file of paths) {
    try {
      const content = await fs.readFile(file, 'utf8');
      if (!content.includes(CLAUDE_MD_START)) continue;
      const stripped = content.replace(blockPattern, '\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
      await fs.writeFile(file, stripped, 'utf8');
    } catch {
      /* file moved/removed — nothing to do */
    }
  }
  await fs.rm(path.join(root, '.ai-stepflow'), { recursive: true, force: true }).catch(() => undefined);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

void (async () => {
  await removeMarkedEntries(path.join(root, 'agents'));
  await removeMarkedEntries(path.join(root, 'skills'));
  await stripClaudeMdBlocks();
})();
