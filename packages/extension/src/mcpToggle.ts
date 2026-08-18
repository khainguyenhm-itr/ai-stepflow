import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McpScope, McpServer } from './mcp.js';

/**
 * Temporarily turning an MCP server off.
 *
 * The `claude` CLI has no disable command — only add/remove — and `remove` throws the server's
 * config away. So "off" here means: lift the server's config object out of `~/.claude.json` and
 * park it verbatim in a stash file we own; "on" puts the exact same object back. Because the whole
 * object round-trips, stdio servers (command/args/env) survive as faithfully as HTTP ones, which a
 * remove+re-add from a URL could never do.
 *
 * OAuth credentials are stored by the CLI separately from the config entry (that is what
 * `claude mcp logout` clears), so parking a server does not sign it out: flipping it back on
 * reconnects without re-authenticating. Signing out is the deliberate, separate action below.
 *
 * Scope is honoured, not rewritten: a user-scope server parked here is off for every project, and
 * a local-scope one only for the project that declared it.
 */

/** Shape of our stash file — mirrors the two buckets `~/.claude.json` keeps servers in. */
interface DisabledStash {
  user?: Record<string, unknown>;
  projects?: Record<string, Record<string, unknown>>;
}

const claudeJsonPath = (home: string) => join(home, '.claude.json');
const stashPath = (home: string) => join(home, '.claude', 'claudesteps-disabled-mcp.json');

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * `~/.claude.json` is 2-space indented with no trailing newline; match it so our writes stay
 * diff-quiet. Written via a sibling temp file and renamed, because that file also holds the user's
 * entire Claude Code state — a torn write there would cost far more than an MCP server.
 */
function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.claudesteps-tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

type ClaudeJson = {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
};

/** Render a stashed config the way `claude mcp list` renders a live one, for the details view. */
function targetOf(config: unknown): string {
  const c = (config ?? {}) as Record<string, unknown>;
  if (typeof c.url === 'string') return `${c.url} (HTTP)`;
  if (typeof c.command === 'string') {
    const args = Array.isArray(c.args) ? c.args.filter(a => typeof a === 'string') : [];
    return [c.command, ...args].join(' ');
  }
  return '';
}

/** Names declared in `~/.claude.json`, split by the bucket that declares them. */
function declaredNames(cwd?: string, home = homedir()): Map<string, McpScope> {
  const json = readJson<ClaudeJson>(claudeJsonPath(home), {});
  const found = new Map<string, McpScope>();
  for (const name of Object.keys(json.mcpServers ?? {})) found.set(name, 'user');
  if (cwd) {
    for (const name of Object.keys(json.projects?.[cwd]?.mcpServers ?? {})) found.set(name, 'local');
  }
  return found;
}

/** The scope that declares this server, or undefined for plugin- and account-provided ones. */
export function findMcpScope(name: string, cwd?: string, home = homedir()): McpScope | undefined {
  return declaredNames(cwd, home).get(name);
}

/** The servers currently parked by the toggle, as list rows the sidebar can render. */
export function listDisabledMcpServers(cwd?: string, home = homedir()): McpServer[] {
  const stash = readJson<DisabledStash>(stashPath(home), {});
  const rows: McpServer[] = [];
  for (const [name, config] of Object.entries(stash.user ?? {})) {
    rows.push({ name, status: 'disabled', target: targetOf(config), scope: 'user', manageable: true });
  }
  if (cwd) {
    for (const [name, config] of Object.entries(stash.projects?.[cwd] ?? {})) {
      rows.push({ name, status: 'disabled', target: targetOf(config), scope: 'local', manageable: true });
    }
  }
  return rows;
}

/**
 * The full picture the sidebar renders: what the CLI reported, tagged with whether we may manage
 * it, plus the parked servers the CLI can no longer see.
 */
export function withDisabledMcpServers(servers: McpServer[], cwd?: string, home = homedir()): McpServer[] {
  const declared = declaredNames(cwd, home);
  const live = servers.map(s => ({ ...s, scope: declared.get(s.name), manageable: declared.has(s.name) }));
  const liveNames = new Set(live.map(s => s.name));
  // A stale stash entry that is somehow live again must not render twice — the live row wins.
  return [...live, ...listDisabledMcpServers(cwd, home).filter(s => !liveNames.has(s.name))];
}

/**
 * Park a server (enable=false) or restore it (enable=true). Writes are ordered so that an
 * interruption can only ever leave the config duplicated, never lost.
 */
export function setMcpServerEnabled(
  name: string,
  enable: boolean,
  cwd?: string,
  home = homedir()
): { ok: boolean; error?: string; scope?: McpScope } {
  const jsonPath = claudeJsonPath(home);
  if (!existsSync(jsonPath)) return { ok: false, error: `${jsonPath} not found.` };

  let json: ClaudeJson;
  try {
    json = JSON.parse(readFileSync(jsonPath, 'utf8')) as ClaudeJson;
  } catch (e) {
    return { ok: false, error: `unable to read ${jsonPath}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const stash = readJson<DisabledStash>(stashPath(home), {});

  try {
    if (enable) {
      const scope: McpScope | undefined =
        stash.user && name in stash.user ? 'user'
          : cwd && stash.projects?.[cwd] && name in stash.projects[cwd] ? 'local'
            : undefined;
      if (!scope) return { ok: false, error: `'${name}' is not currently disabled.` };

      const config = scope === 'user' ? stash.user![name] : stash.projects![cwd!][name];
      if (scope === 'user') {
        json.mcpServers = { ...(json.mcpServers ?? {}), [name]: config };
      } else {
        json.projects = json.projects ?? {};
        json.projects[cwd!] = json.projects[cwd!] ?? {};
        json.projects[cwd!].mcpServers = { ...(json.projects[cwd!].mcpServers ?? {}), [name]: config };
      }
      // Restore first: a crash here leaves the entry in both places, which the next disable resolves.
      writeJson(jsonPath, json);

      if (scope === 'user') delete stash.user![name];
      else delete stash.projects![cwd!][name];
      writeJson(stashPath(home), stash);
      return { ok: true, scope };
    }

    const scope = findMcpScope(name, cwd, home);
    if (!scope) {
      return {
        ok: false,
        error: `'${name}' is not declared in ~/.claude.json — plugin- and account-provided servers must be turned off at their source.`
      };
    }
    const config = scope === 'user' ? json.mcpServers![name] : json.projects![cwd!].mcpServers![name];

    // Stash first: a crash here leaves the entry in both places, which the next enable resolves.
    if (scope === 'user') stash.user = { ...(stash.user ?? {}), [name]: config };
    else stash.projects = { ...(stash.projects ?? {}), [cwd!]: { ...(stash.projects?.[cwd!] ?? {}), [name]: config } };
    writeJson(stashPath(home), stash);

    if (scope === 'user') delete json.mcpServers![name];
    else delete json.projects![cwd!].mcpServers![name];
    writeJson(jsonPath, json);
    return { ok: true, scope };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Clear the server's stored OAuth credentials via `claude mcp logout`, putting it back in the
 * "needs auth" state. The config entry is left alone — only the sign-in is undone.
 */
export function mcpLogout(name: string, cwd?: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    execFile(
      'claude',
      ['mcp', 'logout', name],
      { timeout: 15000, cwd: cwd || undefined },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || error.message || '').trim();
          console.error('ClaudeSteps: failed to sign out of MCP server', detail);
          resolve({ ok: false, error: detail });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}
