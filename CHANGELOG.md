# Changelog

All notable changes to the AI StepFlow extension are documented here. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- **Step runner rewritten for real orchestration.** Each skill in a step now runs
  as its own headless `claude -p` process, in order. Output streams into the
  cockpit console, every skill reports its own exit code, and a step completes
  only when all of its skills exit `0` — replacing the previous interactive-terminal
  approach whose completion state depended on the user quitting Claude.
- Ad-hoc **Run agent** / **Run skill** actions continue to open an interactive
  Claude session in the integrated terminal.
- Flows now keep hand-written YAML comments and top-level key order when saved,
  instead of being flattened on the first edit.

### Added
- **AI review.** A step set to *Auto review* runs a real reviewer (`claude -p`)
  over the step output or a configured review file + checklist, and returns an
  approved / rejected / needs-human verdict.
- All messages received from the webview are validated before use.

### Fixed
- Resuming a run on reopen now restores the most recent *unfinished* run rather
  than the newest run file regardless of state.

### Removed
- Dropped the unused `js-yaml` dependency in favor of `yaml`.
