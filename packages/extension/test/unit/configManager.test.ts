import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigManager } from '../../src/configManager.js';
import { recorder } from './vscodeStub.js';

/**
 * ConfigManager owns every write into a project's `.claudesteps` / `.claude` tree. These tests drive
 * it against a temp workspace only — never `~/.claude`, so a test run cannot touch the real global
 * library. Anything requiring `isGlobal: true` is therefore out of scope here by design.
 */

let workspace: string;

beforeEach(() => {
  recorder.reset();
  workspace = mkdtempSync(path.join(os.tmpdir(), 'claudesteps-cfg-'));
  recorder.workspaceFolders = [{ uri: { fsPath: workspace } }];
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const cm = () => new ConfigManager();

// ---------------------------------------------------------------------------
// Filename derivation — the guard that keeps user input inside the target dir.
// ---------------------------------------------------------------------------

test('an agent filename is slugified, so a name cannot escape the agents directory', async () => {
  const filePath = await cm().saveAgent(
    { name: '../../etc/passwd', description: 'd', model: 'sonnet', tools: [], systemPrompt: 'body' },
    false
  );
  assert.equal(path.dirname(filePath), path.join(workspace, '.claudesteps', 'agents'));
  assert.equal(path.basename(filePath), 'etc-passwd.md');
  assert.equal(existsSync(filePath), true);
});

test('a flow filename is slugified from its id', async () => {
  const filePath = await cm().saveFlow(
    { id: 'My Flow/../..', name: 'My Flow', steps: [] } as never,
    false
  );
  assert.equal(path.dirname(filePath), path.join(workspace, '.claudesteps', 'flows'));
  assert.equal(path.basename(filePath), 'my-flow.yaml');
});

test('a skill lands in its own slugified folder as SKILL.md', async () => {
  const filePath = await cm().saveSkill({ name: 'Write PRD!', description: 'd', instructions: 'body' }, false);
  assert.equal(filePath, path.join(workspace, '.claudesteps', 'skills', 'write-prd', 'SKILL.md'));
});

test('a name that slugifies to nothing still produces a usable filename', async () => {
  const filePath = await cm().saveAgent(
    { name: '!!!', description: 'd', model: 'sonnet', tools: [], systemPrompt: '' },
    false
  );
  assert.equal(path.basename(filePath), 'untitled.md');
});

// ---------------------------------------------------------------------------
// Round-trip: what is written must be what is read back.
// ---------------------------------------------------------------------------

test('an agent round-trips through disk with its frontmatter fields intact', async () => {
  const manager = cm();
  await manager.saveAgent(
    { name: 'po', description: 'product owner', model: 'opus', tools: ['Read', 'Write'], systemPrompt: 'You are the PO.' },
    false
  );
  const loaded = (await manager.loadAgents()).find(a => a.name === 'po');
  assert.ok(loaded, 'saved agent was not loaded back');
  assert.equal(loaded.description, 'product owner');
  assert.equal(loaded.model, 'opus');
  assert.equal(loaded.systemPrompt.trim(), 'You are the PO.');
});

test('a skill round-trips through disk', async () => {
  const manager = cm();
  await manager.saveSkill({ name: 'prd', description: 'write a prd', instructions: 'Do the thing.' }, false);
  const loaded = (await manager.loadSkills()).find(s => s.name === 'prd');
  assert.ok(loaded, 'saved skill was not loaded back');
  assert.equal(loaded.description, 'write a prd');
  assert.equal(loaded.instructions.trim(), 'Do the thing.');
});

test('a review kit round-trips with the AI conversation that generated it', async () => {
  const manager = cm();
  const aiConversation = [
    { role: 'user' as const, content: 'reject a test plan with an unmapped AC' },
    { role: 'assistant' as const, content: 'Review kit generated.' }
  ];
  const filePath = await manager.saveReviewKit(
    { name: 'ac-mapping', description: 'checks AC mapping', content: 'REVIEW CRITERIA', aiConversation },
    false
  );
  const loaded = (await manager.loadReviewKits()).find(k => k.name === 'ac-mapping');
  assert.ok(loaded, 'saved review kit was not loaded back');
  assert.equal(loaded.description, 'checks AC mapping');
  assert.equal(loaded.content, 'REVIEW CRITERIA');
  assert.deepEqual(loaded.aiConversation, aiConversation);
  // The transcript lives in frontmatter only — the body stays pure review criteria, because the
  // body is what `loadReviewKit` feeds the reviewer.
  const raw = readFileSync(filePath, 'utf8');
  assert.match(raw, /^---/);
  assert.equal(raw.split('---')[2].trim(), 'REVIEW CRITERIA');
});

test('a review kit saved without a conversation writes no aiConversation key', async () => {
  const manager = cm();
  const filePath = await manager.saveReviewKit({ name: 'plain', description: 'd', content: 'BODY' }, false);
  assert.ok(!readFileSync(filePath, 'utf8').includes('aiConversation'));
});

test('a flow round-trips with its steps', async () => {
  const manager = cm();
  const flow = {
    id: 'demo',
    name: 'Demo',
    description: 'a demo',
    steps: [{ id: 's1', title: 'Plan', agent: 'po', skill: 'prd', review: { required: true } }],
  } as never;
  await manager.saveFlow(flow, false);
  const loaded = (await manager.loadFlows()).find(f => f.id === 'demo');
  assert.ok(loaded, 'saved flow was not loaded back');
  assert.equal(loaded.name, 'Demo');
  assert.equal(loaded.steps.length, 1);
  assert.equal(loaded.steps[0].agent, 'po');
});

test('saving twice updates in place instead of accumulating files', async () => {
  const manager = cm();
  const first = await manager.saveAgent({ name: 'po', description: 'v1', model: 'sonnet', tools: [], systemPrompt: '' }, false);
  const second = await manager.saveAgent({ name: 'po', description: 'v2', model: 'sonnet', tools: [], systemPrompt: '' }, false);
  assert.equal(first, second);
  const agents = (await manager.loadAgents()).filter(a => a.name === 'po');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].description, 'v2');
});

test('a hand-written flow keeps its YAML comments and key order when re-saved', async () => {
  const manager = cm();
  const flowsDir = path.join(workspace, '.claudesteps', 'flows');
  mkdirSync(flowsDir, { recursive: true });
  const sourcePath = path.join(flowsDir, 'kept.yaml');
  writeFileSync(sourcePath, '# a comment that must survive\nid: kept\nname: Kept\nsteps: []\n', 'utf8');

  await manager.saveFlow({ id: 'kept', name: 'Kept renamed', steps: [], sourcePath } as never, false);

  assert.match(readFileSync(sourcePath, 'utf8'), /# a comment that must survive/);
});

// ---------------------------------------------------------------------------
// Scope + delete guards
// ---------------------------------------------------------------------------

test('isGlobalSourcePath distinguishes the global library from a project path', () => {
  const manager = cm();
  const globalRoot = manager.getGlobalPath();
  assert.equal(manager.isGlobalSourcePath(path.join(globalRoot, 'agents', 'po.md')), true);
  assert.equal(manager.isGlobalSourcePath(path.join(workspace, '.claudesteps', 'agents', 'po.md')), false);
  assert.equal(manager.isGlobalSourcePath(undefined), false);
  assert.equal(manager.isGlobalSourcePath(''), false);
  // A path that merely starts with the same characters is not inside the global root.
  assert.equal(manager.isGlobalSourcePath(`${globalRoot}-other/agents/po.md`), false);
});

test('getProjectPath reflects the open workspace folder', () => {
  assert.equal(cm().getProjectPath(), workspace);
  recorder.workspaceFolders = undefined;
  assert.equal(cm().getProjectPath(), undefined);
});

test('saving to the project without a workspace open fails loudly instead of writing somewhere else', async () => {
  recorder.workspaceFolders = undefined;
  await assert.rejects(
    () => cm().saveAgent({ name: 'po', description: '', model: 'sonnet', tools: [], systemPrompt: '' }, false),
    /No workspace folder is open/
  );
});

test('deleting a file outside the managed config directories is refused', async () => {
  const stray = path.join(workspace, 'src', 'index.ts');
  mkdirSync(path.dirname(stray), { recursive: true });
  writeFileSync(stray, 'export {};', 'utf8');

  await assert.rejects(() => cm().deleteAgent(stray), /Refusing to delete/);
  assert.equal(existsSync(stray), true, 'a file outside the managed dirs was deleted');
});

test('deleting a managed agent removes it from the library', async () => {
  const manager = cm();
  const filePath = await manager.saveAgent({ name: 'po', description: '', model: 'sonnet', tools: [], systemPrompt: '' }, false);
  await manager.deleteAgent(filePath);
  assert.equal(existsSync(filePath), false);
  assert.equal((await manager.loadAgents()).some(a => a.name === 'po'), false);
});

// ---------------------------------------------------------------------------
// Project CLAUDE.md — this method only *removes* the legacy marked block; the rules themselves
// now live in the global ~/.claude/CLAUDE.md (ensureGlobalClaudeMd), which is deliberately not
// exercised here because it writes to the developer's real home directory.
// ---------------------------------------------------------------------------

test('the legacy karpathy block is removed from a project CLAUDE.md, keeping the user content around it', async () => {
  const claudeMd = path.join(workspace, 'CLAUDE.md');
  writeFileSync(
    claudeMd,
    '# My project\n\nNotes above.\n\n<!-- claudesteps:karpathy:start -->\n## Engineering Discipline\n- rule\n<!-- claudesteps:karpathy:end -->\n\nNotes below.\n',
    'utf8'
  );

  await cm().ensureProjectClaudeMd();

  const content = readFileSync(claudeMd, 'utf8');
  assert.equal(content.includes('claudesteps:karpathy'), false, 'legacy block was not removed');
  assert.equal(content.includes('## Engineering Discipline'), false, 'block body was left behind');
  assert.match(content, /Notes above\./, 'user content before the block was dropped');
  assert.match(content, /Notes below\./, 'user content after the block was dropped');
});

test('removing the block is idempotent and leaves a CLAUDE.md without markers untouched', async () => {
  const manager = cm();
  const claudeMd = path.join(workspace, 'CLAUDE.md');
  writeFileSync(claudeMd, '# My project\n\nUser-authored notes.\n', 'utf8');
  const before = readFileSync(claudeMd, 'utf8');

  await manager.ensureProjectClaudeMd();
  await manager.ensureProjectClaudeMd();

  assert.equal(readFileSync(claudeMd, 'utf8'), before, 'a file with no marked block was rewritten');
});

test('a project with no CLAUDE.md is left alone rather than having one created', async () => {
  const claudeMd = path.join(workspace, 'CLAUDE.md');
  await cm().ensureProjectClaudeMd();
  assert.equal(existsSync(claudeMd), false, 'an empty CLAUDE.md was created for no reason');
});
