# Changelog

All notable changes to the ClaudeSteps extension are documented here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security
- **`trustLevel: sandboxed` is now enforced on both run paths.** It was parsed, shown in the
  cockpit, and silently ignored: nothing ever set the write-allow list, so a flow marked
  sandboxed ran with full permissions. Headless and interactive steps now both deny
  `Bash`/`WebFetch`/`WebSearch`, drop to the `default` permission mode, and pre-approve writes
  only to the step's declared `produces` / `review.filePath`. A step declaring no artifacts is
  fail-closed. See the README for the two remaining limits.
- **Interactive launches no longer build shell command lines by hand.** With terminal shell
  integration the argv array is handed to VS Code (`executeCommand(executable, args)`); without
  it, only `claude` and its flags reach the shell and the prompt is typed into the REPL instead.
  The previous quoting escaped for POSIX but wrapped Windows arguments in double quotes, where
  PowerShell expands `$(...)` and backticks — a prompt could execute commands. Quoting is now
  shell-aware (`detectShellKind`/`quoteShellArgs`) and covers PowerShell and cmd correctly.
- **The `ast-graph` download fails closed.** A missing pinned checksum used to fall back to
  fetching the expected hash from the same host that served the archive, which verifies nothing.
  An unverifiable target is now refused, and a test asserts every target pins a real SHA256.
- CI audits the dependencies that actually ship (`npm audit --omit=dev`).

### Changed
- **Step runner driven by a DAG orchestrator.** Each step opens an interactive
  Claude terminal session with its agent + primary skill pre-filled; output streams
  into the cockpit console, and a step completes once its `produces`/review gates
  pass. Steps run one at a time (the rest are parked) to avoid terminal clutter.
- Ad-hoc **Run agent** / **Run skill** actions also open an interactive Claude
  session in the integrated terminal.
- Flows now keep hand-written YAML comments and top-level key order when saved,
  instead of being flattened on the first edit.
- AI review no longer auto-approves when review infrastructure is incomplete.
  Missing review kits, missing produced artifacts, or missing validator-only
  setup now move the step to human review.
- New steps created in the UI now depend on the previous step by default, and
  locked steps show an explicit blocked message if a run is attempted.
- `review.filePath` is treated as the post-run artifact it documents: it must
  exist before completion/review can pass, and AI review reads it directly.
- When a finished step unlocks several dependents at once, the first opens in the
  shared Claude terminal and the rest wait with a notice (previously a fan-out
  stalled silently and required a manual click).
- Run orchestration moved out of the cockpit panel into a dedicated
  `RunOrchestrator`, and host→webview messages are now a typed contract.

### Added
- **The bundled default agents and skills now fan out to subagents.** Every default agent
  carries `Agent` in its `tools:` list (without it the `claude --agent <name>` session cannot
  dispatch one at all), and both the agents and the nine skills with genuinely independent work
  (implement, review, security-review, test-cases, test-run, debug, design, document, refactor)
  carry a shared *Parallel fan-out* section: one subagent per independent slice, dispatched in a
  single message, with the main agent drawing the conclusion. Subagents stay read-only, so writes
  to the declared `produces` artifacts keep exactly one writer and a `sandboxed` flow's deny list
  still holds. `csf-skill-prd` and `csf-skill-test-plan` are left sequential — they synthesize one
  document and have nothing to parallelize.
- **The bundled default agents now run on `opus`.** All seven were pinned to `sonnet`; the
  alias is resolved by the CLI at run time. Note the cockpit's cost estimate reads
  `sessionStats.PRICING` by model prefix, which has no Opus 5 entry and falls back to Sonnet
  rates — an Opus run's reported cost is understated until that table gains the prefix.
- `claudesteps.astGraph.binaryPath` setting to point at a locally-installed
  `ast-graph` on platforms with no prebuilt binary (skips download + checksum).
- A spawn failure for `claude` now names the cause (e.g. "claude CLI not found on
  PATH") instead of surfacing as a bare non-zero exit.
- **AI review.** A step set to *Auto review* runs a real reviewer (`claude -p`)
  over the step output or a configured review file + checklist, and returns an
  approved / rejected / needs-human verdict.
- All messages received from the webview are validated before use.
- Flow steps can declare `requires`, `produces`, and `producesContains` artifact
  gates, including run-input placeholders such as `{feature}`.
- The runner can verify saved runs for artifact drift and export markdown reports
  under `.claude-flow/reports`.
- A packaged `claudesteps` CLI can run flows headlessly and operate saved runs
  with `verify`, `report`, `approve`, `reject`, and `mark-done`.

### Fixed
- Resuming a run on reopen now restores the most recent *unfinished* run rather
  than the newest run file regardless of state.
- `TerminalManager.dispose()` now clears each terminal's pending completion-poll timer and
  sandbox temp file. Deactivating the extension used to leave the poll running until its hard
  cap and leave the temp file behind.

### Added (developer)
- A unit-test harness for the extension host: `npm run test:unit-ext` substitutes a `vscode`
  stub for the bare specifier, so `ConfigManager`, `TerminalManager`, `RunOrchestrator`, the
  webview message guard and the palette can be tested without a VS Code instance. Previously the
  package had no unit tests at all — only three smoke tests inside a real host.
- `npm run test:coverage-ext` gates coverage of the extension modules that are under test, and
  a test diffs the sidebar palette against `App.css` so the two copies cannot drift silently.
- CI runs on every branch (it previously gated `main` only, so most commits ran no checks).

### Removed
- Dropped the unused `js-yaml` dependency in favor of `yaml`.
