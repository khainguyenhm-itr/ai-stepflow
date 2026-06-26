# Changelog

All notable changes to the AI StepFlow extension are documented here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
- `ai-stepflow.astGraph.binaryPath` setting to point at a locally-installed
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
- A packaged `ai-stepflow` CLI can run flows headlessly and operate saved runs
  with `verify`, `report`, `approve`, `reject`, and `mark-done`.

### Fixed
- Resuming a run on reopen now restores the most recent *unfinished* run rather
  than the newest run file regardless of state.

### Removed
- Dropped the unused `js-yaml` dependency in favor of `yaml`.
