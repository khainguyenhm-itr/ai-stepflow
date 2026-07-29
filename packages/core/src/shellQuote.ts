/**
 * shellQuote.ts — shell-correct argument quoting for command lines we have to build as
 * a single string (the `Terminal.sendText` fallback, where no argv array is accepted).
 *
 * Kept dependency-free and in `core` so it is unit-testable without a VS Code host.
 *
 * Prefer NOT to use this: when terminal shell integration is available, pass an argv array
 * to `TerminalShellIntegration.executeCommand(executable, args)` and let VS Code quote for
 * the real shell. This module exists only for the no-shell-integration fallback.
 */

/** The shell families we can quote for. Anything unrecognised is treated as POSIX. */
export type ShellKind = 'posix' | 'powershell' | 'cmd';

/**
 * Characters that are safe unquoted in every shell we support. Deliberately conservative:
 * no `%` (cmd variable expansion), no `$`/backtick (POSIX + PowerShell expansion), no `=`
 * or `,` (cmd token delimiters), no backslash (Windows paths get quoted instead).
 */
const SAFE_TOKEN = /^[A-Za-z0-9_@+:./-]+$/;

/**
 * Classify the shell a command line is about to be typed into.
 *
 * `shellPath` is the shell executable (VS Code exposes it as `vscode.env.shell`). On Windows the
 * default profile is PowerShell for all supported VS Code versions, so an unknown Windows shell
 * falls back to PowerShell rather than cmd — PowerShell's single-quote rule is literal and cannot
 * be tricked into expansion, which is the safer guess of the two.
 */
export function detectShellKind(platform: string, shellPath?: string): ShellKind {
  const shell = (shellPath ?? '').toLowerCase();
  if (/(^|[\\/])(pwsh|powershell)(\.exe)?$/.test(shell) || shell.includes('powershell')) return 'powershell';
  if (/(^|[\\/])cmd(\.exe)?$/.test(shell)) return 'cmd';
  if (shell) return 'posix';
  // No shell reported: guess from the platform.
  return platform === 'win32' ? 'powershell' : 'posix';
}

/**
 * Quote one argument so the target shell passes it through as a single literal token.
 *
 * - **posix**: single quotes; an embedded `'` is closed, escaped, reopened (`'\''`). Nothing
 *   expands inside single quotes, so this is fully literal.
 * - **powershell**: single quotes; an embedded `'` is doubled (`''`). PowerShell does not expand
 *   `$var`, `$(...)` or backticks inside single quotes, so this is fully literal. (Double quotes
 *   would NOT be — that was the original bug.)
 * - **cmd**: double quotes; an embedded `"` is doubled (`""`) and `%` is doubled (`%%`). Inside
 *   double quotes cmd treats `&`, `|`, `<`, `>` and `^` literally, so command execution is not
 *   reachable; `%%` is cmd's own escape for a literal percent.
 */
export function quoteShellArg(arg: string, kind: ShellKind): string {
  if (arg.length > 0 && SAFE_TOKEN.test(arg)) return arg;
  if (kind === 'cmd') {
    // cmd.exe has no escape for `%` inside double quotes. Doubling it (`%%`) is the documented
    // batch-file escape and is what cmd itself emits; at an interactive prompt a lone `%VAR%`
    // whose variable is undefined is passed through literally anyway. Worst case is an
    // environment value leaking into the argument — never command execution, because `&`, `|`,
    // `>` and `^` are literal inside double quotes.
    return `"${arg.replace(/"/g, '""').replace(/%/g, '%%')}"`;
  }
  if (kind === 'powershell') {
    return `'${arg.replace(/'/g, "''")}'`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Quote and join an argv array into a single command line for {@link quoteShellArg}'s shell. */
export function quoteShellArgs(args: string[], kind: ShellKind): string {
  return args.map(arg => quoteShellArg(arg, kind)).join(' ');
}
