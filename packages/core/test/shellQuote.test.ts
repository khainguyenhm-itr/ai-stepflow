import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectShellKind, quoteShellArg, quoteShellArgs, ShellKind } from '@claudesteps/core';

/**
 * Payloads that must never survive quoting as anything but literal text. Each one is a live
 * expansion in at least one shell: `$(…)`/backtick execute in POSIX shells, `$(…)` and backtick
 * also execute in PowerShell *inside double quotes*, and `&`/`|`/`;` chain commands unquoted.
 */
const INJECTIONS = [
  '$(touch /tmp/pwned)',
  '`touch /tmp/pwned`',
  '${IFS}whoami',
  'a; touch /tmp/pwned',
  'a && touch /tmp/pwned',
  'a | tee /tmp/pwned',
  'a > /tmp/pwned',
  "it's a prompt",
  'say "hi"',
  'newline\nrm -rf /',
];

const KINDS: ShellKind[] = ['posix', 'powershell', 'cmd'];

test('detectShellKind classifies the shells VS Code reports', () => {
  assert.equal(detectShellKind('darwin', '/bin/zsh'), 'posix');
  assert.equal(detectShellKind('linux', '/usr/bin/bash'), 'posix');
  assert.equal(detectShellKind('win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'powershell');
  assert.equal(detectShellKind('win32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'powershell');
  assert.equal(detectShellKind('win32', 'C:\\Windows\\System32\\cmd.exe'), 'cmd');
  // Git Bash on Windows is POSIX despite the platform.
  assert.equal(detectShellKind('win32', 'C:\\Program Files\\Git\\bin\\bash.exe'), 'posix');
});

test('detectShellKind guesses PowerShell on Windows and POSIX elsewhere when no shell is reported', () => {
  // PowerShell is the safer guess: its single-quote rule is fully literal, cmd's is not.
  assert.equal(detectShellKind('win32', undefined), 'powershell');
  assert.equal(detectShellKind('win32', ''), 'powershell');
  assert.equal(detectShellKind('darwin', undefined), 'posix');
  assert.equal(detectShellKind('linux', ''), 'posix');
});

test('plain tokens are passed through unquoted in every shell', () => {
  for (const kind of KINDS) {
    assert.equal(quoteShellArg('claude', kind), 'claude');
    assert.equal(quoteShellArg('--session-id', kind), '--session-id');
    assert.equal(quoteShellArg('6f1c9a2e-0b3d-4c7a-9e5f-1a2b3c4d5e6f', kind), '6f1c9a2e-0b3d-4c7a-9e5f-1a2b3c4d5e6f');
    assert.equal(quoteShellArg('docs/plan.md', kind), 'docs/plan.md');
  }
});

test('every injection payload comes back fully enclosed in quotes, in every shell', () => {
  for (const kind of KINDS) {
    for (const payload of INJECTIONS) {
      const quoted = quoteShellArg(payload, kind);
      const quote = kind === 'cmd' ? '"' : "'";
      assert.equal(quoted.startsWith(quote), true, `${kind}: ${payload} not opened with ${quote}`);
      assert.equal(quoted.endsWith(quote), true, `${kind}: ${payload} not closed with ${quote}`);
    }
  }
});

test('POSIX quoting keeps an embedded single quote from ending the literal', () => {
  // The classic break-out: the arg's own quote must close-escape-reopen, not terminate the string.
  assert.equal(quoteShellArg("a'b", 'posix'), "'a'\\''b'");
  assert.equal(quoteShellArg("'; rm -rf /; '", 'posix'), "''\\''; rm -rf /; '\\'''");
});

test('PowerShell quoting uses single quotes so $() and backticks cannot expand', () => {
  // This is the bug that was there: double quotes in PowerShell DO expand $(...) and backticks,
  // so a prompt containing $(...) executed. Single quotes are literal.
  assert.equal(quoteShellArg('$(whoami)', 'powershell'), "'$(whoami)'");
  assert.equal(quoteShellArg('`whoami`', 'powershell'), "'`whoami`'");
  assert.equal(quoteShellArg('$env:PATH', 'powershell'), "'$env:PATH'");
  assert.equal(quoteShellArg('", $(whoami), "', 'powershell'), "'\", $(whoami), \"'");
  // An embedded single quote is doubled, PowerShell's own escape.
  assert.equal(quoteShellArg("it's", 'powershell'), "'it''s'");
  for (const payload of INJECTIONS) {
    assert.equal(quoteShellArg(payload, 'powershell').includes('"'), payload.includes('"'));
  }
});

test('PowerShell quoting never emits a double-quoted string (the original expansion vector)', () => {
  for (const payload of INJECTIONS) {
    assert.equal(quoteShellArg(payload, 'powershell').startsWith('"'), false, payload);
  }
});

test('cmd quoting doubles quotes and percent signs so no token escapes the argument', () => {
  assert.equal(quoteShellArg('say "hi"', 'cmd'), '"say ""hi"""');
  assert.equal(quoteShellArg('%USERPROFILE%', 'cmd'), '"%%USERPROFILE%%"');
  // & | > < are literal inside cmd double quotes, so command chaining is unreachable.
  assert.equal(quoteShellArg('a & calc', 'cmd'), '"a & calc"');
});

test('quoteShellArgs joins an argv into one command line, quoting only what needs it', () => {
  const args = ['claude', '--agent', 'my agent', '--model', 'sonnet'];
  assert.equal(quoteShellArgs(args, 'posix'), "claude --agent 'my agent' --model sonnet");
  assert.equal(quoteShellArgs(args, 'powershell'), "claude --agent 'my agent' --model sonnet");
  assert.equal(quoteShellArgs(args, 'cmd'), 'claude --agent "my agent" --model sonnet');
});

test('an empty argument is quoted rather than vanishing from the command line', () => {
  for (const kind of KINDS) {
    const quoted = quoteShellArg('', kind);
    assert.notEqual(quoted, '', `${kind}: empty arg collapsed`);
    assert.equal(quoted.length, 2, `${kind}: empty arg should be an empty quoted string`);
  }
});

test('a Windows path is quoted rather than passed raw (backslashes are not in the safe set)', () => {
  assert.equal(quoteShellArg('C:\\Users\\me\\.claude', 'powershell'), "'C:\\Users\\me\\.claude'");
  assert.equal(quoteShellArg('C:\\Program Files\\x', 'cmd'), '"C:\\Program Files\\x"');
});
