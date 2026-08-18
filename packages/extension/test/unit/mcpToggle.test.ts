import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setMcpServerEnabled, withDisabledMcpServers, listDisabledMcpServers, findMcpScope } from '../../src/mcpToggle.js';
import type { McpServer } from '../../src/mcp.js';

/**
 * The toggle's whole promise is that turning a server off and back on is lossless: the config
 * object must survive verbatim (a remove+re-add from a URL could not do that for stdio servers),
 * and it must land back in the scope it came from. These tests pin exactly that, plus the refusal
 * to touch servers we do not own.
 */

const PROJECT = '/tmp/proj-under-test';

/** A home directory with a `~/.claude.json` holding one user-scope and one local-scope server. */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'cs-mcp-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    numStartups: 7,
    mcpServers: {
      figma: { type: 'http', url: 'https://figma.example/mcp' }
    },
    projects: {
      [PROJECT]: {
        allowedTools: [],
        mcpServers: { 'ast-graph': { command: 'node', args: ['run.cjs', '--mcp'], env: { AG_DEBUG: '1' } } }
      }
    }
  }, null, 2));
  return home;
}

const readClaudeJson = (home: string) => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));

test('disabling a user-scope server lifts it out of ~/.claude.json and stashes it', () => {
  const home = makeHome();
  const res = setMcpServerEnabled('figma', false, PROJECT, home);
  assert.equal(res.ok, true);
  assert.equal(res.scope, 'user');

  const json = readClaudeJson(home);
  assert.ok(!('figma' in json.mcpServers), 'the entry must be gone from the live config');
  assert.equal(json.numStartups, 7, 'unrelated fields must survive the rewrite');

  const disabled = listDisabledMcpServers(PROJECT, home);
  assert.deepEqual(disabled.map(s => s.name), ['figma']);
  assert.equal(disabled[0].status, 'disabled');
  assert.equal(disabled[0].scope, 'user');
  assert.match(disabled[0].target!, /figma\.example/);

  rmSync(home, { recursive: true, force: true });
});

test('re-enabling restores the exact config object, in its original scope', () => {
  const home = makeHome();
  const before = readClaudeJson(home).projects[PROJECT].mcpServers['ast-graph'];

  assert.equal(setMcpServerEnabled('ast-graph', false, PROJECT, home).scope, 'local');
  assert.equal(readClaudeJson(home).projects[PROJECT].mcpServers['ast-graph'], undefined);

  const back = setMcpServerEnabled('ast-graph', true, PROJECT, home);
  assert.equal(back.ok, true);
  assert.equal(back.scope, 'local');

  const after = readClaudeJson(home).projects[PROJECT].mcpServers['ast-graph'];
  assert.deepEqual(after, before, 'command, args and env must round-trip untouched');
  assert.deepEqual(listDisabledMcpServers(PROJECT, home), [], 'the stash must be emptied');

  rmSync(home, { recursive: true, force: true });
});

test('a local-scope server stays visible only to the project that declared it', () => {
  const home = makeHome();
  assert.equal(findMcpScope('ast-graph', PROJECT, home), 'local');
  assert.equal(findMcpScope('ast-graph', '/some/other/project', home), undefined);

  setMcpServerEnabled('ast-graph', false, PROJECT, home);
  assert.deepEqual(listDisabledMcpServers('/some/other/project', home), []);
  assert.deepEqual(listDisabledMcpServers(PROJECT, home).map(s => s.name), ['ast-graph']);

  rmSync(home, { recursive: true, force: true });
});

test('servers we do not own are refused rather than half-removed', () => {
  const home = makeHome();
  const res = setMcpServerEnabled('plugin:github:github', false, PROJECT, home);
  assert.equal(res.ok, false);
  assert.match(res.error!, /not declared/);
  assert.equal(existsSync(join(home, '.claude', 'claudesteps-disabled-mcp.json')), false);

  rmSync(home, { recursive: true, force: true });
});

test('enabling something that was never disabled is a no-op error', () => {
  const home = makeHome();
  const res = setMcpServerEnabled('figma', true, PROJECT, home);
  assert.equal(res.ok, false);
  assert.match(res.error!, /not currently disabled/);
  rmSync(home, { recursive: true, force: true });
});

test('the rendered list merges parked servers back in and marks what we may manage', () => {
  const home = makeHome();
  setMcpServerEnabled('figma', false, PROJECT, home);

  // What `claude mcp list` would report once figma is parked: it simply is not there any more.
  const live: McpServer[] = [
    { name: 'ast-graph', status: 'connected', target: 'node run.cjs --mcp' },
    { name: 'plugin:github:github', status: 'connected', target: 'gh mcp' }
  ];
  const merged = withDisabledMcpServers(live, PROJECT, home);

  const byName = Object.fromEntries(merged.map(s => [s.name, s]));
  assert.equal(byName['ast-graph'].manageable, true);
  assert.equal(byName['ast-graph'].scope, 'local');
  assert.equal(byName['plugin:github:github'].manageable, false, 'plugin servers must get no switch');
  assert.equal(byName['figma'].status, 'disabled');

  rmSync(home, { recursive: true, force: true });
});

test('a stale stash entry never renders twice — the live row wins', () => {
  const home = makeHome();
  setMcpServerEnabled('figma', false, PROJECT, home);
  // Simulate the user re-adding figma via the CLI while our stash still holds a copy.
  const json = readClaudeJson(home);
  json.mcpServers.figma = { type: 'http', url: 'https://figma.example/mcp' };
  writeFileSync(join(home, '.claude.json'), JSON.stringify(json, null, 2));

  const merged = withDisabledMcpServers([{ name: 'figma', status: 'connected' }], PROJECT, home);
  assert.equal(merged.filter(s => s.name === 'figma').length, 1);
  assert.equal(merged[0].status, 'connected');

  rmSync(home, { recursive: true, force: true });
});
