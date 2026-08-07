import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { TerminalManager } from '../../src/terminalManager.js';
import type { ConfigManager } from '../../src/configManager.js';
import { recorder, fakeShellIntegration } from './vscodeStub.js';

/** ConfigManager is only consulted to resolve an agent name; tests pass agent objects instead. */
const configStub = { loadAgents: async () => [] } as unknown as ConfigManager;

const lastTerminal = () => recorder.terminals[recorder.terminals.length - 1];

beforeEach(() => recorder.reset());

// ---------------------------------------------------------------------------
// Shell-integration path: an argv array, so nothing is parsed by a shell.
// ---------------------------------------------------------------------------

test('with shell integration the prompt travels as an argv entry, never on a command line', async () => {
  recorder.shellIntegrationForNewTerminals = fakeShellIntegration();
  const tm = new TerminalManager(configStub);

  await tm.runInTerminal('$(touch /tmp/pwned)', '/repo', undefined, true, 'step-1', 'sess-1', 'run-1');

  const term = lastTerminal();
  assert.equal(term.executed.length, 1);
  const { executable, args } = term.executed[0];
  assert.equal(executable, 'claude');
  // The payload is one argv element, not text spliced into a command string.
  assert.equal(args.includes('$(touch /tmp/pwned)'), true);
  // Nothing was typed at a shell prompt at all.
  assert.equal(term.sent.length, 0);
  tm.dispose();
});

test('a pre-fill (submit=false) launches claude bare and types the prompt unsent', async () => {
  recorder.shellIntegrationForNewTerminals = fakeShellIntegration();
  const tm = new TerminalManager(configStub);

  await tm.runInTerminal('review this', '/repo', undefined, false, 'step-1', 'sess-1', 'run-1');

  const term = lastTerminal();
  assert.equal(term.executed[0].args.includes('review this'), false, 'prompt must not be submitted via argv');
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.deepEqual(term.sent, [{ text: 'review this', submit: false }]);
  tm.dispose();
});

// ---------------------------------------------------------------------------
// sendText fallback: a real command line, so the prompt must stay off it.
// ---------------------------------------------------------------------------

test('without shell integration the command line carries only claude + flags, and the prompt is typed in', async () => {
  recorder.shellIntegrationForNewTerminals = undefined;
  recorder.shell = '/bin/zsh';
  const tm = new TerminalManager(configStub);

  await tm.runInTerminal('$(touch /tmp/pwned)', '/repo', undefined, true, 'step-1', 'sess-1', 'run-1');

  const term = lastTerminal();
  const commandLine = term.sent[0].text;
  assert.equal(commandLine.includes('touch /tmp/pwned'), false, 'prompt text reached the shell command line');
  assert.equal(commandLine.startsWith('claude --session-id sess-1'), true);

  // The prompt is delivered separately, into the REPL — text first, then a lone Enter.
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.deepEqual(term.sent.slice(1), [
    { text: '$(touch /tmp/pwned)', submit: false },
    { text: '', submit: true },
  ]);
  tm.dispose();
});

test('a multi-line auto-enter prompt is submitted by a separate Enter, not a trailing newline', async () => {
  recorder.shellIntegrationForNewTerminals = fakeShellIntegration();
  const tm = new TerminalManager(configStub);
  const prompt = '/plan do the thing\n\nMandatory input files:\n- a.md';

  // First launch claims the terminal, then a Re-run types into the still-live REPL.
  await tm.runInTerminal(prompt, '/repo', undefined, true, 'step-1', 'sess-1', 'run-1');
  const term = lastTerminal();
  term.sent.length = 0;
  await tm.runInTerminal(prompt, '/repo', undefined, true, 'step-1', 'sess-1', 'run-1');

  // The text must never carry the submit flag: Claude Code folds that CR into the paste.
  assert.deepEqual(term.sent, [{ text: prompt, submit: false }]);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(term.sent, [{ text: prompt, submit: false }, { text: '', submit: true }]);
  tm.dispose();
});

test('a re-run pre-fill (submit=false) types the prompt and never sends an Enter', async () => {
  recorder.shellIntegrationForNewTerminals = fakeShellIntegration();
  const tm = new TerminalManager(configStub);

  await tm.runInTerminal('go', '/repo', undefined, true, 'step-1', 'sess-1', 'run-1');
  const term = lastTerminal();
  term.sent.length = 0;
  await tm.runInTerminal('review this', '/repo', undefined, false, 'step-1', 'sess-1', 'run-1');

  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(term.sent, [{ text: 'review this', submit: false }]);
  tm.dispose();
});

test('an agent name with shell metacharacters is quoted for the reported shell', async () => {
  recorder.shellIntegrationForNewTerminals = undefined;
  recorder.shell = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const tm = new TerminalManager(configStub);

  const agent = { name: '$(whoami)', description: '', model: 'sonnet', tools: [], systemPrompt: '' } as never;
  await tm.runInTerminal('', '/repo', agent, true, undefined, 'sess-2');

  const commandLine = lastTerminal().sent[0].text;
  // PowerShell single quotes are literal; a double-quoted string would have expanded $(...).
  assert.equal(commandLine.includes("'$(whoami)'"), true, commandLine);
  assert.equal(commandLine.includes('"$(whoami)"'), false, commandLine);
  tm.dispose();
});

// ---------------------------------------------------------------------------
// Sandbox enforcement (trustLevel: sandboxed).
// ---------------------------------------------------------------------------

test('a trusted step adds no sandbox flags', async () => {
  recorder.shellIntegrationForNewTerminals = fakeShellIntegration();
  const tm = new TerminalManager(configStub);

  await tm.runInTerminal('go', '/repo', undefined, true, 'step-1', 'sess-1', 'run-1');

  const { args } = lastTerminal().executed[0];
  assert.equal(args.includes('--allowedTools'), false);
  assert.equal(args.includes('--settings'), false);
  assert.equal(args.includes('--permission-mode'), false);
  tm.dispose();
});

test('a sandboxed step denies exec/network and pre-approves only its declared writes', async () => {
  recorder.shellIntegrationForNewTerminals = fakeShellIntegration();
  const tm = new TerminalManager(configStub);

  await tm.runInTerminal('go', '/repo', undefined, true, 'step-1', 'sess-1', 'run-1', undefined, ['docs/plan.md']);

  const { args } = lastTerminal().executed[0];
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  const rules = args.slice(args.indexOf('--allowedTools') + 1);
  assert.equal(rules.includes('Write(docs/plan.md)'), true);
  assert.equal(rules.includes('Edit(docs/plan.md)'), true);

  // The deny list is handed over as a file so no JSON has to survive a shell.
  const settingsPath = args[args.indexOf('--settings') + 1];
  assert.equal(settingsPath.endsWith('.json'), true, settingsPath);
  const deny = JSON.parse(readFileSync(settingsPath, 'utf8')) as { permissions: { deny: string[] } };
  assert.deepEqual(deny.permissions.deny.sort(), ['Bash', 'WebFetch', 'WebSearch']);
  tm.dispose();
});

test('a sandboxed step declaring no artifacts is fail-closed (deny settings, no write rule)', async () => {
  recorder.shellIntegrationForNewTerminals = fakeShellIntegration();
  const tm = new TerminalManager(configStub);

  await tm.runInTerminal('go', '/repo', undefined, true, 'step-1', 'sess-1', 'run-1', undefined, []);

  const { args } = lastTerminal().executed[0];
  assert.equal(args.includes('--settings'), true);
  assert.equal(args.includes('--allowedTools'), false, 'nothing may be pre-approved for writing');
  tm.dispose();
});

test('the sandbox settings file is removed when the run is cancelled', async () => {
  recorder.shellIntegrationForNewTerminals = fakeShellIntegration();
  const tm = new TerminalManager(configStub);

  await tm.runInTerminal('go', '/repo', undefined, true, 'step-1', 'sess-1', 'run-1', undefined, ['docs/a.md']);
  const { args } = lastTerminal().executed[0];
  const settingsPath = args[args.indexOf('--settings') + 1];
  assert.equal(existsSync(settingsPath), true);

  assert.equal(tm.cancelStep('run-1', 'step-1'), true);
  assert.equal(existsSync(settingsPath), false, 'temp settings file leaked after cancel');
  tm.dispose();
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('each step of a run gets its own terminal so concurrent runs do not share a session', async () => {
  recorder.shellIntegrationForNewTerminals = fakeShellIntegration();
  const tm = new TerminalManager(configStub);

  await tm.runInTerminal('a', '/repo', undefined, true, 'step-1', 's1', 'run-1');
  await tm.runInTerminal('b', '/repo', undefined, true, 'step-1', 's2', 'run-2');

  assert.equal(recorder.terminals.length, 2);
  assert.notEqual(recorder.terminals[0].options.name, recorder.terminals[1].options.name);
  tm.dispose();
});

test('two ad-hoc runs get independent terminals rather than reusing one session', async () => {
  recorder.shellIntegrationForNewTerminals = fakeShellIntegration();
  const tm = new TerminalManager(configStub);

  await tm.runInTerminal('a', '/repo', undefined, true, undefined, 's1');
  await tm.runInTerminal('b', '/repo', undefined, true, undefined, 's2');

  assert.equal(recorder.terminals.length, 2);
  tm.dispose();
});

test('cancelStep on an unknown step reports nothing was closed', () => {
  const tm = new TerminalManager(configStub);
  assert.equal(tm.cancelStep('run-x', 'step-x'), false);
  tm.dispose();
});

test('resumeSession launches claude --resume via an argv array', async () => {
  recorder.shellIntegrationForNewTerminals = fakeShellIntegration();
  const tm = new TerminalManager(configStub);

  await tm.resumeSession('sess-9', '/repo', 'my agent');

  const { executable, args } = lastTerminal().executed[0];
  assert.equal(executable, 'claude');
  assert.deepEqual(args, ['--resume', 'sess-9']);
  tm.dispose();
});
