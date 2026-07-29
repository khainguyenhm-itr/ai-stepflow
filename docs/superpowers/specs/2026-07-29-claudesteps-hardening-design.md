# ClaudeSteps Hardening — Design

**Date:** 2026-07-29
**Status:** Approved (Phases 1–3; Phase 4 dropped)

## Goal

Address the repo's top weaknesses with the lowest-risk sequencing: raise test
coverage on untested god-files, then shrink those files by extracting the pure
logic the new tests already pin. Refactors change **no behavior** — a green test
suite before and after each extraction is the proof.

## Guiding principle: test-first → refactor

For each god-file:
1. Extract pure logic into a new module (no framework/VS Code deps).
2. Write unit tests for the extracted module.
3. The original file imports the module back — net line reduction, no behavior change.

Verification after every phase: `npm test` and the coverage gates stay green.

## Scope

In: webview `useAppLogic`, extension `runOrchestrator` / `configManager` /
`webviewPanel` / `sidebarHtml`, concurrent-run routing tests, webview coverage gate.

Out (dropped): commit-message / process standardization (former Phase 4). No git
history rewrite. No unrelated refactoring or formatting churn.

## Phase 1 — Webview: extract `useAppLogic` message router + test

**Problem.** `handleHostMessage` in `packages/webview/src/hooks/useAppLogic.ts`
is a ~660-line, 16-case router whose state transitions live inside `setState`
callbacks. It is untestable without React and currently has zero tests. The whole
webview has only 2 test files for 39 source files and no coverage gate.

**Change.**
- New pure module `packages/webview/src/hooks/appState/hostMessageReducers.ts`:
  each host message maps to a pure `(prev, message) => next` function. No React,
  no side effects. Side-effecting cases (e.g. persisting UI prefs, posting back to
  the host) keep their side effects in `useAppLogic`; only the state math moves.
- `useAppLogic.handleHostMessage` becomes a thin dispatcher that calls the
  reducers inside `setState`. Target: `useAppLogic.ts` from 808 → ~250 lines.
- New test `packages/webview/test/hostMessageReducers.test.ts` covering all 16
  cases, emphasizing **run isolation by `runId`**: `restoreRun` (previousRunId
  drop), `runClosed`, `runDeleted`, `stepUpdate`, `aiReviewUpdate`,
  `runStateChanged` must never mutate another run's state. This doubles as the
  webview-side concurrent-run test.
- Add the new module to `packages/webview/test/tsconfig.json` `include` and add a
  webview c8 config + `test:coverage-webview` gate (mirrors `.c8rc.json`).

**Risk:** low. Pure extraction guarded by new tests.

## Phase 2 — Extension: concurrent-run routing tests

**Problem.** Per-run isolation (`_rk`, `_withRun`, `_purgeRunKeys`,
`_killRunChildren`, `_focused` in `runOrchestrator.ts`) is the area most recently
stabilized (commits "phase 1–4b: per-run terminals") and is thinly tested.

**Change.**
- Extract the pure run-keying helpers (`runKey(runId, stepId)`, `withRun` message
  tagging) into `packages/extension/src/runOrchestratorHelpers.ts`.
- Extend `packages/extension/test/unit/runOrchestrator.test.ts` (exists) to cover
  key isolation: two runs with the same stepId produce distinct keys; `withRun`
  tags a message with its runId; purge removes only one run's keys.

**Risk:** low.

## Phase 3 — Split god-files (only after test coverage from Phases 1–2)

Each extraction target already has a clean seam:

- **`runOrchestrator.ts` (1227).** Extract:
  - `runOrchestratorHelpers.ts` (from Phase 2) — plus pure helpers
    `_runTimeoutMs`, `_runMaxTurns`, `_runSlug`/`_legacyRunSlug`,
    `_validateRequires`, `_validateProduces`, `_headlessMcpConfig`,
    `_readAmbientMcpServers`. Unit-tested.
  - `runReview.ts` — `_reviewStep` / `_runAiReview` review-gate logic.
- **`configManager.ts` (989).** Extract `bundledLibrary.ts` — bundled
  install/prune/list (`installBundledDefaults`, `pruneRenamedDefaults`,
  `pruneRenamedSkillFolders`, `recordInstallRoot`, `listBundledDefaults`,
  `_firstHeading`, `_firstJsComment`). `ConfigManager` keeps scan/save/CLAUDE.md.
- **`webviewPanel.ts` (845).** Extract the `_dispatch` router (300+ lines) and
  generation helpers (`_runGenerationPrompt`, `_handleGenerateDraft`,
  `_handleGenerateFlow`, `_normalize*`) into `webviewDispatch.ts` /
  `webviewGeneration.ts`.
- **`sidebarHtml.ts` (1173).** Split into fragments (head/styles, body, script).
  Test is **light**: assert the CSP meta, the nonce wiring, and each fragment
  marker are present — no full-HTML snapshot (brittle, low value).

**Risk:** medium. Mitigated by test-first ordering and running the full suite
(unit + integration) after each file.

## Testing strategy

- Framework: `node:test` + `node:assert/strict` (matches existing suites).
- Webview pure modules compiled via `packages/webview/test/tsconfig.json`.
- Extension pure modules via the existing unit test path + `vscodeStub`.
- New webview coverage gate; existing core (85% lines) and extension-module gates
  unchanged. New extracted extension modules added to `.c8rc.extension.json`
  include list as they gain tests.
- Definition of done per phase: `npm test` green, coverage gates pass, no behavior
  change observable in the integration suite.
