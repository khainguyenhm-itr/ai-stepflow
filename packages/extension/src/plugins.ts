import { execFile } from 'child_process';

/** An installed Claude plugin. */
export interface PluginInfo {
  /** Full id, e.g. "figma@claude-plugins-official" — used for enable/disable/uninstall. */
  id: string;
  /** Display name, e.g. "figma". */
  name: string;
  version: string;
  scope: string;
  enabled: boolean;
}

/** A plugin offered by a configured marketplace that is not yet installed. */
export interface AvailablePlugin {
  /** Full id, e.g. "figma@claude-plugins-official" — passed to `plugin install`. */
  id: string;
  name: string;
  description: string;
  marketplace: string;
}

export interface PluginCatalog {
  installed: PluginInfo[];
  available: AvailablePlugin[];
}

const nameFromId = (id: unknown): string => String(id ?? '').split('@')[0];

/** Map the CLI's installed-plugin JSON record to our {@link PluginInfo}. */
function toPluginInfo(p: any): PluginInfo {
  return {
    id: String(p?.id ?? ''),
    name: nameFromId(p?.id),
    version: p?.version || 'unknown',
    scope: p?.scope || 'unknown',
    enabled: !!p?.enabled
  };
}

/**
 * One CLI call (`plugin list --available --json`) returns both the installed plugins
 * and the marketplace catalog. Available entries already installed are filtered out.
 * Falls back to `plugin list --json` (installed only) if the marketplace probe fails.
 */
export function listPluginCatalog(): Promise<PluginCatalog> {
  return new Promise(resolve => {
    execFile(
      'claude',
      ['plugin', 'list', '--available', '--json'],
      { timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (!error || stdout) {
          try {
            const data = JSON.parse(stdout);
            const installed: PluginInfo[] = (data.installed || []).map(toPluginInfo);
            const installedIds = new Set(installed.map(p => p.id));
            const available: AvailablePlugin[] = (data.available || [])
              .filter((p: any) => !installedIds.has(String(p?.pluginId ?? '')))
              .map((p: any) => ({
                id: String(p?.pluginId ?? ''),
                name: p?.name || nameFromId(p?.pluginId),
                description: p?.description || '',
                marketplace: p?.marketplaceName || ''
              }));
            resolve({ installed, available });
            return;
          } catch {
            /* fall through to the installed-only fallback */
          }
        }
        listInstalledOnly().then(installed => resolve({ installed, available: [] }));
      }
    );
  });
}

/** Fallback when the marketplace probe is unavailable: installed plugins only. */
function listInstalledOnly(): Promise<PluginInfo[]> {
  return new Promise(resolve => {
    execFile('claude', ['plugin', 'list', '--json'], { timeout: 15000 }, (error, stdout) => {
      if (error && !stdout) {
        console.warn('AI StepFlow: unable to list plugins', error);
        resolve([]);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        resolve((Array.isArray(data) ? data : data.installed || []).map(toPluginInfo));
      } catch (e) {
        console.warn('AI StepFlow: failed to parse plugin list', e);
        resolve([]);
      }
    });
  });
}

/** Run a `claude plugin …` action, surfacing the CLI's stderr message on failure. */
function runPluginAction(args: string[], timeout: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    execFile('claude', args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || stdout || error.message || '').trim();
        console.error(`AI StepFlow: \`claude ${args.join(' ')}\` failed`, detail);
        resolve({ ok: false, error: detail });
        return;
      }
      resolve({ ok: true });
    });
  });
}

/** Enable or disable an installed plugin via `claude plugin {enable|disable}`. */
export function togglePlugin(id: string, enable: boolean): Promise<{ ok: boolean; error?: string }> {
  return runPluginAction(['plugin', enable ? 'enable' : 'disable', id], 15000);
}

/** Install a plugin via `claude plugin install` (accepts `plugin@marketplace`). */
export function installPlugin(id: string): Promise<{ ok: boolean; error?: string }> {
  return runPluginAction(['plugin', 'install', id], 60000);
}

/**
 * Uninstall a plugin via `claude plugin uninstall`, preserving its persistent data
 * directory (`~/.claude/plugins/data/{id}/`) so a later reinstall keeps its config/state.
 */
export function uninstallPlugin(id: string): Promise<{ ok: boolean; error?: string }> {
  return runPluginAction(['plugin', 'uninstall', id, '--keep-data'], 60000);
}
