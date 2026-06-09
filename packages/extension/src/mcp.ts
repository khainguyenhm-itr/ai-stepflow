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
          .filter(line => /✓\s*Connected/i.test(line))
          .map(line => line.split(':', 1)[0].trim())
          .filter(Boolean);
        resolve(connected);
      }
    );
  });
}
