import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type McpStatus = 'connected' | 'needs-auth' | 'failed' | 'unknown';

export interface McpServer {
  name: string;
  status: McpStatus;
  target?: string;
}

/**
 * Returns the absolute path of the config file that declares the given MCP server,
 * or undefined if not found. Checks project-level first, then user-global.
 */
export function findMcpConfigFile(name: string, cwd?: string): string | undefined {
  const candidates: string[] = [];
  if (cwd) {
    candidates.push(join(cwd, '.claude', 'settings.json'));
    candidates.push(join(cwd, '.claude', 'settings.local.json'));
  }
  candidates.push(join(homedir(), '.claude.json'));

  for (const filePath of candidates) {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const servers = parsed['mcpServers'] as Record<string, unknown> | undefined;
      if (servers && Object.prototype.hasOwnProperty.call(servers, name)) {
        return filePath;
      }
    } catch {
      // file missing or invalid JSON — skip
    }
  }
  return undefined;
}

/** Classify one `claude mcp list` line by the status suffix the CLI appends. */
function statusOf(line: string): McpStatus {
  // Healthy servers are marked with a checkmark — tolerate both the light (U+2713 ✓)
  // and heavy (U+2714 ✔) glyphs the CLI has used across versions.
  if (/[✓✔]\s*Connected/i.test(line)) return 'connected';
  if (/needs?\s+auth/i.test(line)) return 'needs-auth';
  if (/✘|failed to connect/i.test(line)) return 'failed';
  return 'unknown';
}

/**
 * Lists every MCP server the `claude` CLI knows about, with its health status.
 * Lines look like `NAME: <url-or-cmd> [(HTTP)] - <status>`; the name ends at the
 * first ": " (a colon followed by a space), which tolerates names that themselves
 * contain colons (e.g. `plugin:slack:slack`) or dots (e.g. `claude.ai Notion`).
 * Spawns the CLI (slow cold start) so it must run off the UI's critical path, and
 * never rejects — any failure resolves to an empty list so callers render safely.
 */
export function listMcpServers(cwd?: string): Promise<McpServer[]> {
  return new Promise(resolve => {
    execFile(
      'claude',
      ['mcp', 'list'],
      { timeout: 15000, cwd: cwd || undefined },
      (error, stdout) => {
        if (error && !stdout) {
          console.warn('AI StepFlow: unable to inspect MCP servers', error);
          resolve([]);
          return;
        }
        const servers: McpServer[] = [];
        for (const raw of stdout.split(/\r?\n/)) {
          const line = raw.trim();
          const sep = line.indexOf(': ');
          if (sep <= 0) continue; // header ("Checking MCP server health…") and blanks
          const name = line.slice(0, sep).trim();
          const rest = line.slice(sep + 2).trim();
          const target = rest.replace(/\s+-\s+(?:✓|✔|✘)?\s*.*$/u, '').trim();
          if (name) servers.push({ name, status: statusOf(line), target });
        }
        resolve(servers);
      }
    );
  });
}

/** Backward-compatible helper: names of servers the CLI reports as connected. */
export function listConnectedMcpServers(cwd?: string): Promise<string[]> {
  return listMcpServers(cwd).then(servers =>
    servers.filter(s => s.status === 'connected').map(s => s.name)
  );
}

/**
 * Add a remote (HTTP) MCP server via `claude mcp add --transport http <name> <url>`.
 * Used by the sidebar's curated catalog of popular servers. Auth (when required) is
 * handled by the CLI on first use, so the server shows as "needs auth" until then.
 */
export function addRemoteMcpServer(opts: {
  name: string;
  url: string;
  scope: 'user' | 'local';
  cwd?: string;
}): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    execFile(
      'claude',
      ['mcp', 'add', '--transport', 'http', opts.name, opts.url, '--scope', opts.scope],
      { timeout: 30000, cwd: opts.cwd || undefined },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || error.message || '').trim();
          console.error('AI StepFlow: failed to add remote MCP server', detail);
          resolve({ ok: false, error: detail });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}

/**
 * Re-add an existing remote MCP server using the target shown by `claude mcp list`.
 * This gives failed HTTP servers a direct retry path from the sidebar.
 */
export function reconnectRemoteMcpServer(opts: {
  name: string;
  target: string;
  scope: 'user' | 'local';
  cwd?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const url = opts.target.replace(/\s+\(HTTP\)\s*$/i, '').trim();
  return new Promise(resolve => {
    execFile(
      'claude',
      ['mcp', 'remove', opts.name],
      { timeout: 15000, cwd: opts.cwd || undefined },
      (removeError, removeStdout, removeStderr) => {
        if (removeError) {
          const detail = (removeStderr || removeStdout || removeError.message || '').trim();
          console.error('AI StepFlow: failed to remove MCP server before reconnect', detail);
          resolve({ ok: false, error: detail });
          return;
        }
        addRemoteMcpServer({ name: opts.name, url, scope: opts.scope, cwd: opts.cwd }).then(resolve);
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
