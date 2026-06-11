/**
 * Runs (via the `vscode:uninstall` package.json script) when the extension is removed.
 * Cleans up everything this extension wrote outside its own folder, in every `.claude`
 * root it installed into (global ~/.claude plus any project roots recorded at install time):
 *   - default agent/skill/validator/review files (identified by the built-in marker)
 *   - the Karpathy block merged into each root's CLAUDE.md (identified by start/end markers)
 * Plain Node only: no `vscode` API, so marker strings are duplicated rather than imported.
 */
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

const MARKER = 'ai-stepflow built-in';
const CLAUDE_MD_START = '<!-- ai-stepflow:karpathy:start -->';
const CLAUDE_MD_END = '<!-- ai-stepflow:karpathy:end -->';
const globalRoot = path.join(os.homedir(), '.claude');
const trackDir = path.join(globalRoot, '.ai-stepflow');

/** The default subfolders we install into, with the extensions we own in each. */
const KINDS: { dir: string; exts: string[] }[] = [
  { dir: 'agents', exts: ['.md'] },
  { dir: 'skills', exts: ['.md'] },
  { dir: 'validators', exts: ['.mjs', '.js'] },
  { dir: 'reviews', exts: ['.md'] }
];

/** Remove marker-stamped files (and folder-based skills) we installed under `<root>/<kind>`. */
async function removeMarkedEntries(dir: string, exts: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // dir absent — nothing installed here
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    try {
      if (entry.isFile() && exts.some(ext => entry.name.endsWith(ext))) {
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

/** Strip the marked Karpathy block (and any surrounding blank lines) from one CLAUDE.md. */
async function stripClaudeMd(file: string): Promise<void> {
  const blockPattern = new RegExp(
    `\\n*${escapeRegExp(CLAUDE_MD_START)}[\\s\\S]*?${escapeRegExp(CLAUDE_MD_END)}\\n*`,
    'g'
  );
  try {
    const content = await fs.readFile(file, 'utf8');
    if (!content.includes(CLAUDE_MD_START)) return;
    const stripped = content.replace(blockPattern, '\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    await fs.writeFile(file, stripped, 'utf8');
  } catch {
    /* file moved/removed — nothing to do */
  }
}

/** Read the `.claude` roots we installed into; always include the global root. */
async function installedRoots(): Promise<string[]> {
  const roots = new Set<string>([globalRoot]);
  try {
    const recorded = JSON.parse(await fs.readFile(path.join(trackDir, 'installed-roots.json'), 'utf8'));
    if (Array.isArray(recorded)) recorded.filter(r => typeof r === 'string').forEach(r => roots.add(r));
  } catch {
    /* no manifest (older install or global-only) — global root alone is fine */
  }
  return [...roots];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

void (async () => {
  for (const root of await installedRoots()) {
    for (const { dir, exts } of KINDS) {
      await removeMarkedEntries(path.join(root, dir), exts);
    }
    await stripClaudeMd(path.join(root, 'CLAUDE.md'));
  }
  // Legacy: older builds recorded individual CLAUDE.md paths instead of roots.
  try {
    const paths = JSON.parse(await fs.readFile(path.join(trackDir, 'claude-md-paths.json'), 'utf8'));
    if (Array.isArray(paths)) for (const p of paths) await stripClaudeMd(p);
  } catch {
    /* none */
  }
  await fs.rm(trackDir, { recursive: true, force: true }).catch(() => undefined);
})();
