import { execFile } from 'child_process';

export interface PluginInfo {
  name: string;
  version: string;
  scope: string;
  enabled: boolean;
}

/**
 * Lists plugins installed in the `claude` CLI.
 */
export function listPlugins(): Promise<PluginInfo[]> {
  return new Promise(resolve => {
    execFile(
      'claude',
      ['plugin', 'list'],
      { timeout: 15000 },
      (error, stdout) => {
        if (error && !stdout) {
          console.warn('AI StepFlow: unable to list plugins', error);
          resolve([]);
          return;
        }

        const plugins: PluginInfo[] = [];
        const blocks = stdout.split(/\r?\n\r?\n/).filter(b => b.trim().startsWith('❯'));
        
        for (const block of blocks) {
          const lines = block.split(/\r?\n/).map(l => l.trim());
          const name = lines[0].replace('❯', '').trim();
          const version = lines.find(l => l.startsWith('Version:'))?.split(':')[1]?.trim() || 'unknown';
          const scope = lines.find(l => l.startsWith('Scope:'))?.split(':')[1]?.trim() || 'unknown';
          const statusLine = lines.find(l => l.startsWith('Status:')) || '';
          const enabled = /enabled/i.test(statusLine);
          
          if (name) {
            plugins.push({ name, version, scope, enabled });
          }
        }
        resolve(plugins);
      }
    );
  });
}

/**
 * Enables or disables a plugin via `claude plugin {enable|disable}`.
 */
export function togglePlugin(name: string, enable: boolean): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    execFile(
      'claude',
      ['plugin', enable ? 'enable' : 'disable', name],
      { timeout: 15000 },
      (error, _stdout, stderr) => {
        if (error) {
          console.error(`AI StepFlow: failed to ${enable ? 'enable' : 'disable'} plugin ${name}`, error, stderr);
          resolve({ ok: false, error: stderr || error.message });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}

/**
 * Installs a plugin via `claude plugin install`.
 */
export function installPlugin(name: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    execFile(
      'claude',
      ['plugin', 'install', name],
      { timeout: 60000 }, // Installation might take longer
      (error, _stdout, stderr) => {
        if (error) {
          console.error(`AI StepFlow: failed to install plugin ${name}`, error, stderr);
          resolve({ ok: false, error: stderr || error.message });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}
