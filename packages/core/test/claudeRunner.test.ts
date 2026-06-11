import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runClaudeStreaming, TIMEOUT_EXIT_CODE } from '@ai-stepflow/core';

/**
 * A stand-in for a spawned `claude` process: emits stdout/stderr/close like the real
 * ChildProcess, but driven by the test. `kill()` only records the call (a real child
 * emits 'close' asynchronously, so a kill never races the close handler synchronously).
 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() { this.killed = true; return true; }
}

const spawnReturning = (child: FakeChild) => ((() => child) as unknown) as Parameters<typeof runClaudeStreaming>[1];

test('runClaudeStreaming parses NDJSON assistant text + result usage', async () => {
  const child = new FakeChild();
  const chunks: string[] = [];
  const handle = runClaudeStreaming(
    { systemPrompt: 'sys', userMessage: 'hi', projectPath: '/x', onText: c => chunks.push(c) },
    spawnReturning(child)
  );

  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'hello' }] } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', result: 'final', total_cost_usd: 0.02, model: 'claude-x', usage: { input_tokens: 3, output_tokens: 5 } }) + '\n'));
  child.emit('close', 0);

  const r = await handle.completed;
  assert.equal(r.success, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.resultText, 'final');
  assert.equal(r.costUsd, 0.02);
  assert.equal(r.tokensUsed, 8);
  assert.equal(r.model, 'claude-x');
  assert.deepEqual(chunks, ['hello']);
  assert.equal(r.timedOut, undefined);
});

test('runClaudeStreaming passes non-JSON stdout lines through as text', async () => {
  const child = new FakeChild();
  const chunks: string[] = [];
  const handle = runClaudeStreaming(
    { systemPrompt: '', userMessage: 'x', projectPath: '', onText: c => chunks.push(c) },
    spawnReturning(child)
  );
  child.stdout.emit('data', Buffer.from('not json\n'));
  child.emit('close', 1);

  const r = await handle.completed;
  assert.equal(r.success, false);
  assert.equal(r.exitCode, 1);
  assert.ok(chunks.join('').includes('not json'));
});

test('runClaudeStreaming surfaces a clear message when claude is not on PATH (ENOENT)', async () => {
  const child = new FakeChild();
  const chunks: string[] = [];
  const handle = runClaudeStreaming(
    { systemPrompt: '', userMessage: 'x', projectPath: '', onText: c => chunks.push(c) },
    spawnReturning(child)
  );
  const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  child.emit('error', enoent);

  const r = await handle.completed;
  assert.equal(r.success, false);
  assert.equal(r.exitCode, 1);
  assert.match(chunks.join(''), /claude CLI not found on PATH/);
});

test('runClaudeStreaming reports a non-ENOENT spawn failure with its message', async () => {
  const child = new FakeChild();
  const chunks: string[] = [];
  const handle = runClaudeStreaming(
    { systemPrompt: '', userMessage: 'x', projectPath: '', onText: c => chunks.push(c) },
    spawnReturning(child)
  );
  child.emit('error', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

  const r = await handle.completed;
  assert.equal(r.success, false);
  assert.match(chunks.join(''), /failed to launch claude: EACCES/);
});

test('runClaudeStreaming times out, kills the child, and reports timedOut', async () => {
  const child = new FakeChild();
  const handle = runClaudeStreaming(
    { systemPrompt: '', userMessage: 'x', projectPath: '', onText: () => {}, timeoutMs: 20 },
    spawnReturning(child)
  );
  const r = await handle.completed;
  assert.equal(r.timedOut, true);
  assert.equal(r.success, false);
  assert.equal(r.exitCode, TIMEOUT_EXIT_CODE);
  assert.equal(child.killed, true);
});

test('a close arriving after a timeout does not overwrite the timed-out result', async () => {
  const child = new FakeChild();
  const handle = runClaudeStreaming(
    { systemPrompt: '', userMessage: 'x', projectPath: '', onText: () => {}, timeoutMs: 20 },
    spawnReturning(child)
  );
  const r = await handle.completed;
  child.emit('close', 0); // late close from the killed child — must be ignored
  assert.equal(r.timedOut, true);
  assert.equal(r.success, false);
});
