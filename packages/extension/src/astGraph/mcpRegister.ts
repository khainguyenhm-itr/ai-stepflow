/**
 * Register the bundled `ast-graph` binary as a `local`-scoped MCP server via the
 * `claude mcp` CLI. Local scope = scoped to one project dir, matching our per-workspace db,
 * so a headless `claude -p` run in that project inherits the tools automatically.
 *
 * All failure modes are non-fatal and surfaced via the returned status.
 */

import { execFile } from 'child_process';

export interface McpRegistration {
  ok: boolean;
  /** When false, explains why (CLI missing, timeout, error). */
  reason: string;
}

export type McpInspectionStatus = 'missing' | 'connected' | 'failed' | 'wrong-target' | 'unknown';

export interface McpInspection {
  status: McpInspectionStatus;
  reason: string;
  target?: string;
}

const MCP_NAME = 'ast-graph';
const ADD_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 20_000;
const REMOVE_TIMEOUT_MS = 15_000;

interface RegisterOpts {
  binPath: string;
  dbPath: string;
  cwd: string;
  claudeBin?: string;
}

/** Run `claude mcp add ast-graph --scope local -- <binPath> mcp --db <dbPath>` inside `cwd`. */
export function registerMcpServer(opts: RegisterOpts): Promise<McpRegistration> {
  const claude = opts.claudeBin ?? 'claude';
  const args = ['mcp', 'add', MCP_NAME, '--scope', 'local', '--', opts.binPath, 'mcp', '--db', opts.dbPath];

  return new Promise((resolve) => {
    execFile(claude, args, { timeout: ADD_TIMEOUT_MS, cwd: opts.cwd }, (err, _stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          resolve({ ok: false, reason: `\`${claude}\` not found on PATH — install the Claude Code CLI to enable MCP.` });
          return;
        }
        if (code === 'ETIMEDOUT') {
          resolve({ ok: false, reason: 'claude mcp add timed out (>15s).' });
          return;
        }
        resolve({ ok: false, reason: (stderr || err.message).toString().trim().split(/\r?\n/).slice(-3).join(' | ') });
        return;
      }
      resolve({ ok: true, reason: '' });
    });
  });
}

/** Inspect the local ast-graph MCP registration for `cwd` and verify that it points at this repo's db. */
export function inspectMcpServer(opts: RegisterOpts): Promise<McpInspection> {
  const claude = opts.claudeBin ?? 'claude';
  return new Promise((resolve) => {
    execFile(claude, ['mcp', 'list'], { timeout: LIST_TIMEOUT_MS, cwd: opts.cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          resolve({ status: 'unknown', reason: `\`${claude}\` not found on PATH — install the Claude Code CLI to enable MCP.` });
          return;
        }
        if (code === 'ETIMEDOUT') {
          resolve({ status: 'unknown', reason: 'claude mcp list timed out (>20s).' });
          return;
        }
        resolve({ status: 'unknown', reason: err.message });
        return;
      }

      const mcpLine = stdout.split(/\r?\n/).find((line) => line.trim().toLowerCase().startsWith(`${MCP_NAME}:`));
      if (!mcpLine) {
        resolve({ status: 'missing', reason: 'not registered' });
        return;
      }

      const target = extractTarget(mcpLine);
      if (!targetMatches(target, opts.binPath, opts.dbPath)) {
        resolve({ status: 'wrong-target', reason: `registered target does not match ${opts.dbPath}`, target });
        return;
      }
      if (/[✓✔]\s*Connected/i.test(mcpLine)) {
        resolve({ status: 'connected', reason: 'connected', target });
        return;
      }
      if (/✘|failed to connect/i.test(mcpLine)) {
        resolve({ status: 'failed', reason: 'registered but failed to connect', target });
        return;
      }
      resolve({ status: 'unknown', reason: 'registered but status is unknown', target });
    });
  });
}

/** Ensure the local ast-graph MCP server exists, is healthy, and points at this repo's graph db. */
export async function reconcileMcpServer(opts: RegisterOpts): Promise<McpRegistration> {
  const inspected = await inspectMcpServer(opts);
  if (inspected.status === 'connected') {
    return { ok: true, reason: 'connected' };
  }
  if (inspected.status === 'unknown') {
    return { ok: false, reason: inspected.reason };
  }
  if (inspected.status !== 'missing') {
    const removed = await removeMcpServer(opts);
    if (!removed.ok) return removed;
  }
  const registered = await registerMcpServer(opts);
  if (registered.ok) {
    const verified = await inspectMcpServer(opts);
    if (verified.status === 'connected') return { ok: true, reason: 'connected' };
    return { ok: false, reason: verified.reason || `registered but ${verified.status}` };
  }
  return registered;
}

function removeMcpServer(opts: RegisterOpts): Promise<McpRegistration> {
  const claude = opts.claudeBin ?? 'claude';
  return new Promise((resolve) => {
    execFile(claude, ['mcp', 'remove', MCP_NAME, '--scope', 'local'], { timeout: REMOVE_TIMEOUT_MS, cwd: opts.cwd }, (err, _stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          resolve({ ok: false, reason: `\`${claude}\` not found on PATH — install the Claude Code CLI to enable MCP.` });
          return;
        }
        if (code === 'ETIMEDOUT') {
          resolve({ ok: false, reason: 'claude mcp remove timed out (>15s).' });
          return;
        }
        resolve({ ok: false, reason: (stderr || err.message).toString().trim().split(/\r?\n/).slice(-3).join(' | ') });
        return;
      }
      resolve({ ok: true, reason: '' });
    });
  });
}

function extractTarget(line: string): string {
  const sep = line.indexOf(': ');
  if (sep < 0) return '';
  return line.slice(sep + 2).replace(/\s+-\s+(?:✓|✔|✘)?\s*.*$/u, '').trim();
}

function targetMatches(target: string, binPath: string, dbPath: string): boolean {
  const normalized = target.replace(/^"|"$/g, '');
  return normalized.includes(binPath) && normalized.includes(dbPath);
}
