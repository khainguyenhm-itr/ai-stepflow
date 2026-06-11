import { execFile } from 'child_process';

/**
 * Lists MCP servers the `claude` CLI reports as connected. Spawns the CLI, so it
 * is slow (cold start) and must be called off the UI's critical path. Never
 * rejects — any failure resolves to an empty list so callers can render safely.
 */
export function listConnectedMcpServers(cwd?: string): Promise<string[]> {
  return new Promise(resolve => {
    execFile(
      'claude',
      ['mcp', 'list'],
      { timeout: 15000, cwd: cwd || undefined },
      (error, stdout) => {
        if (error && !stdout) {
          console.warn('AI StepFlow: unable to inspect connected MCP servers', error);
          resolve([]);
          return;
        }
        const connected = stdout
          .split(/\r?\n/)
          // The CLI marks healthy servers with a checkmark before "Connected"; tolerate both
          // the light (U+2713 ✓) and heavy (U+2714 ✔) glyphs it has used across versions.
          .filter(line => /[✓✔]\s*Connected/i.test(line))
          .map(line => line.split(':', 1)[0].trim())
          .filter(Boolean);
        resolve(connected);
      }
    );
  });
}

/**
 * Connect a new MCP server via `claude mcp add`. Supports optional environment
 * variables by prepending them to the command (on Unix-like systems).
 */
export function addMcpServer(opts: {
  name: string;
  scope: 'global' | 'local';
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    const fullCommand: string[] = [];
    if (opts.env && Object.keys(opts.env).length > 0) {
      fullCommand.push('env');
      for (const [k, v] of Object.entries(opts.env)) {
        fullCommand.push(`${k}=${v}`);
      }
    }
    fullCommand.push(opts.command, ...opts.args);

    const args = ['mcp', 'add', opts.name, '--scope', opts.scope, '--', ...fullCommand];

    execFile(
      'claude',
      args,
      { timeout: 30000, cwd: opts.cwd || undefined },
      (error, _stdout, stderr) => {
        if (error) {
          console.error('AI StepFlow: failed to add MCP server', error, stderr);
          resolve({ ok: false, error: stderr || error.message });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}
