import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMessage } from '../../src/messages.js';

/**
 * `validateMessage` is the extension host's only trust boundary against the webview: everything
 * that reaches a file-writing or process-spawning handler passes through here first. These tests
 * assert the boundary rejects malformed input rather than letting it reach a handler.
 */

const agent = { name: 'po', description: 'd', model: 'sonnet', tools: [], systemPrompt: 'body' };
const skill = { name: 'prd', description: 'd', instructions: 'body' };
const flow = {
  id: 'f1',
  name: 'Flow',
  // sourcePath is required by the shape guard: it is the file path the save/delete handlers act on.
  sourcePath: '/repo/.claudesteps/flows/f1.yaml',
  steps: [{ id: 's1', title: 'S1', agent: 'po', skill: 'prd', review: { required: true } }],
};

test('a non-object, a missing type, and an unknown type are all rejected', () => {
  for (const raw of [null, undefined, 42, 'ready', [], { }, { type: 42 }, { type: 'notAThing' }]) {
    assert.equal(validateMessage(raw), null, `accepted ${JSON.stringify(raw)}`);
  }
});

test('a no-payload message is accepted on type alone', () => {
  for (const type of ['ready', 'cancelGenerate', 'connectGitnexus', 'importAgentFile']) {
    assert.notEqual(validateMessage({ type }), null, type);
  }
});

test('optional runId is accepted when absent and rejected when not a string', () => {
  for (const type of ['resetRun', 'deleteRun', 'verifyRun', 'exportRunReport']) {
    assert.notEqual(validateMessage({ type }), null, `${type} without runId`);
    assert.notEqual(validateMessage({ type, runId: 'r1' }), null, `${type} with runId`);
    assert.equal(validateMessage({ type, runId: 7 }), null, `${type} accepted a numeric runId`);
    assert.equal(validateMessage({ type, runId: null }), null, `${type} accepted a null runId`);
  }
});

test('closeRun requires finalize to be boolean when present', () => {
  assert.notEqual(validateMessage({ type: 'closeRun', finalize: true }), null);
  assert.notEqual(validateMessage({ type: 'closeRun' }), null);
  assert.equal(validateMessage({ type: 'closeRun', finalize: 'yes' }), null);
  assert.equal(validateMessage({ type: 'closeRun', finalize: 1 }), null);
});

test('openFile / openWorkspace / revealPath require a string path', () => {
  for (const type of ['openFile', 'openWorkspace', 'revealPath']) {
    assert.notEqual(validateMessage({ type, path: 'docs/a.md' }), null, type);
    assert.equal(validateMessage({ type }), null, `${type} accepted a missing path`);
    assert.equal(validateMessage({ type, path: 12 }), null, `${type} accepted a numeric path`);
    assert.equal(validateMessage({ type, path: { toString: () => 'x' } }), null, `${type} accepted an object path`);
  }
});

test('saveFlow validates the flow element-deep, not just "is an object"', () => {
  assert.notEqual(validateMessage({ type: 'saveFlow', flow }), null);
  assert.equal(validateMessage({ type: 'saveFlow' }), null);
  assert.equal(validateMessage({ type: 'saveFlow', flow: {} }), null);
  assert.equal(validateMessage({ type: 'saveFlow', flow: { ...flow, sourcePath: undefined } }), null);
  // A steps array whose elements lack the id the handlers key on must be rejected element-deep,
  // not waved through by an "is an array" check.
  assert.equal(validateMessage({ type: 'saveFlow', flow: { ...flow, steps: [{ title: 'no id' }] } }), null);
  assert.equal(validateMessage({ type: 'saveFlow', flow: { ...flow, steps: ['nope'] } }), null);
  assert.equal(validateMessage({ type: 'saveFlow', flow: { ...flow, steps: 'nope' } }), null);
});

test('agent and skill payloads are validated on every handler that writes them to disk', () => {
  for (const type of ['createAgent', 'updateAgent', 'runAgent']) {
    assert.notEqual(validateMessage({ type, agent }), null, type);
    assert.equal(validateMessage({ type }), null, `${type} accepted a missing agent`);
    assert.equal(validateMessage({ type, agent: { description: 'no name' } }), null, `${type} accepted a nameless agent`);
  }
  for (const type of ['createSkill', 'updateSkill', 'runSkill']) {
    assert.notEqual(validateMessage({ type, skill }), null, type);
    assert.equal(validateMessage({ type }), null, `${type} accepted a missing skill`);
    assert.equal(validateMessage({ type, skill: { description: 'no name' } }), null, `${type} accepted a nameless skill`);
  }
});

test('delete handlers require a sourcePath, since that is the file they remove', () => {
  assert.notEqual(validateMessage({ type: 'deleteFlow', flow: { sourcePath: '/p/.claudesteps/flows/f.yaml' } }), null);
  assert.equal(validateMessage({ type: 'deleteFlow', flow: {} }), null);
  assert.notEqual(validateMessage({ type: 'deleteAgent', agent: { sourcePath: '/p/a.md' } }), null);
  assert.equal(validateMessage({ type: 'deleteAgent', agent: { name: 'po' } }), null);
  assert.notEqual(validateMessage({ type: 'deleteSkill', skill: { sourcePath: '/p/SKILL.md' } }), null);
  assert.equal(validateMessage({ type: 'deleteSkill', skill: {} }), null);
});

test('runStep requires a stepId and validates any flow / runState it carries', () => {
  assert.notEqual(validateMessage({ type: 'runStep', stepId: 's1' }), null);
  assert.equal(validateMessage({ type: 'runStep' }), null);
  assert.equal(validateMessage({ type: 'runStep', stepId: 1 }), null);
  assert.equal(validateMessage({ type: 'runStep', stepId: 's1', flow: { id: 'f' } }), null);
  assert.equal(validateMessage({ type: 'runStep', stepId: 's1', runState: { nope: true } }), null);
});

test('reviewStep only accepts the two decisions the handler branches on', () => {
  assert.notEqual(validateMessage({ type: 'reviewStep', stepId: 's1', decision: 'approved' }), null);
  assert.notEqual(validateMessage({ type: 'reviewStep', stepId: 's1', decision: 'rejected' }), null);
  assert.equal(validateMessage({ type: 'reviewStep', stepId: 's1', decision: 'maybe' }), null);
  assert.equal(validateMessage({ type: 'reviewStep', stepId: 's1' }), null);
});

test('runCommand only accepts commands from the runnable allow-list', () => {
  // The guard that keeps the webview from asking the host to execute an arbitrary command id.
  assert.equal(validateMessage({ type: 'runCommand', command: 'workbench.action.terminal.kill' }), null);
  assert.equal(validateMessage({ type: 'runCommand', command: 'claudesteps.somethingElse' }), null);
  assert.equal(validateMessage({ type: 'runCommand' }), null);
  assert.notEqual(validateMessage({ type: 'runCommand', command: 'claudesteps.installDefaults' }), null);
});

test('connectMcpServer requires both the name and the command it will spawn', () => {
  assert.notEqual(validateMessage({ type: 'connectMcpServer', config: { name: 'gitnexus', command: 'gitnexus' } }), null);
  assert.equal(validateMessage({ type: 'connectMcpServer', config: { name: 'gitnexus' } }), null);
  assert.equal(validateMessage({ type: 'connectMcpServer', config: { command: 'gitnexus' } }), null);
  assert.equal(validateMessage({ type: 'connectMcpServer' }), null);
});

test('getAdhocRuns and generateDraft constrain kind to the two library kinds', () => {
  assert.notEqual(validateMessage({ type: 'getAdhocRuns', kind: 'agent', name: 'po' }), null);
  assert.notEqual(validateMessage({ type: 'getAdhocRuns', kind: 'skill', name: 'prd' }), null);
  assert.equal(validateMessage({ type: 'getAdhocRuns', kind: 'flow', name: 'f' }), null);
  assert.equal(validateMessage({ type: 'getAdhocRuns', kind: 'agent' }), null);
  assert.notEqual(validateMessage({ type: 'generateDraft', kind: 'agent', prompt: 'p' }), null);
  assert.equal(validateMessage({ type: 'generateDraft', kind: 'agent' }), null);
});

test('editRun requires an inputs object and savePref requires both key and value', () => {
  assert.notEqual(validateMessage({ type: 'editRun', inputs: {} }), null);
  assert.equal(validateMessage({ type: 'editRun' }), null);
  assert.equal(validateMessage({ type: 'editRun', inputs: 'nope' }), null);
  assert.notEqual(validateMessage({ type: 'savePref', key: 'k', value: 'v' }), null);
  assert.equal(validateMessage({ type: 'savePref', key: 'k' }), null);
});

test('a valid message is returned as-is, so handlers see the original payload', () => {
  const raw = { type: 'openFile', path: 'docs/a.md' };
  assert.equal(validateMessage(raw), raw);
});
