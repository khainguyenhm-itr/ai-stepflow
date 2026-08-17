# Mid-run workflow edit: reconcile or reset

Date: 2026-08-17
Status: approved (design)

## Problem

`saveFlow` (`packages/extension/src/webviewPanel.ts:121`) writes the flow file and calls
`_sendAllData()`. Live runs are untouched: each `RunCtx` in `RunOrchestrator._runs` keeps the
flow snapshot it was created with. Editing a workflow while a run is in flight therefore
diverges silently — the run state has no entry for a newly added step, a removed step keeps
running, artifacts and audit logs stay bound to the old shape, and nothing tells the user.

## Goal

When a flow is saved while at least one of its runs is live:

- **Safe edit** (only touches work that has not started): save, then reconcile every live run —
  in-memory flow, run state, per-run bookkeeping, and the persisted files.
- **Unsafe edit** (touches work already done/in flight): show a modal warning. Confirm → save and
  reset every live run of that flow from the edited flow. Cancel → the flow is not saved at all.

## Decisions

| Question | Decision |
|---|---|
| "before/after the running step" | By actual progress over the `dependsOn` DAG, not array index |
| Which edits are considered | Any edit that affects a step: add, remove, or modify — plus three flow-level fields (see below) |
| What "reset" means | Full run reset, reusing `RunOrchestrator.resetRun` |
| Which runs | Every live run of that flow (`_runs`, matching `flow.id`, not `isClosed`) |
| Popup | Native VS Code modal (`showWarningMessage`, `{ modal: true }`) |

## Architecture

```
webview saveFlow ──► CockpitPanel case 'saveFlow'   (webviewPanel.ts:121)
                        │
                        ├─ runner.assessFlowEdit(newFlow)   ◄── core: assessFlowEdit(old, new, runState)
                        │      → per live run: { runId, runName, blocking[], added[], removed[], modified[] }
                        │
                        ├─ no blocking ─► configManager.saveFlow ─► runner.syncFlowIntoLiveRuns(newFlow)
                        │
                        └─ blocking ─► showWarningMessage(modal)
                                        ├─ Cancel ─► do NOT write the file; post 'flowSaveCancelled'
                                        └─ OK     ─► configManager.saveFlow ─► runner.resetRunsForFlow(newFlow)
```

The comparison lives in a new pure module `packages/core/src/flowEditImpact.ts` — no `vscode`
import, unit-testable with `node --test` like the rest of `packages/core`. The extension only
orchestrates. Putting the diff in the webview was rejected: the webview does not know about
background runs, and `_runs` is the source of truth.

## Classification rules

`progressed(stepState)` — the step consumed real work:

```
executionStatus ∈ { running, completed, failed, cancelled, skipped }  OR  completionStatus === 'done'
```

`changed` — union of:

- `added`: step id present in the new flow, absent in the old
- `removed`: step id present in the old flow, absent in the new
- `modified`: id present in both, `FlowStep` objects not deeply equal

A changed step is **blocking** when it:

- is itself `progressed`, **or**
- is an ancestor (via `dependsOn`, over the union of the old and new edge sets) of a `progressed`
  step.

Flow-level rules, added because these break work already produced:

- `flow.name` changed → blocking if any step in the run has progressed. `machine.flowOutputDir`
  derives the run's artifact directory from `flow.name`; renaming mid-run orphans existing
  artifacts.
- `flow.inputs` or `flow.trustLevel` changed → blocking if any step has progressed. Both feed
  `runIf` gating and path templates.
- `flow.description` / `flow.aiConversation` changed → always safe; sync only.

A run with no progressed step is always safe, whatever the edit.

**Accepted trade-off:** editing only the `title` of a completed step is classified blocking. The
comparison is a whole-object deep equal; title also reaches the composed prompt, so erring toward
safety is correct.

## Safe path — `syncFlowIntoLiveRuns(newFlow)`

For each live run of the flow:

| Target | Action |
|---|---|
| `rc.flow` | replace with the new flow |
| `runState.steps` | add a default entry (`ready` / `pending` / `not_ready` / empty output) per added step; delete entries for removed steps; leave the rest untouched |
| `runState.flowName`, `runState.source` | sync from the new flow |
| dependency locks | `applyDependencyLocks(newFlow, steps)` |
| `RunCtx` bookkeeping | drop removed step ids from `startedStepIds`, `parkedStepIds`, `autoRetryStepIds`, `stepStartTimes`, `readinessSnapshots`, `outputChunkBuffer`; drop `${runId}::${stepId}` from `_cancelledStepIds` |
| `completedNotified` | back to `false` when the run again has unfinished steps |
| run file | `stateManager.saveRun(runState)` |
| audit log | `clearAuditLog(flowId, runId, removedIds)` |
| review reports | `deleteReviewReports(runState, removedIds)` |
| webview | `post({ type: 'restoreRun', flow, runState })` per run, plus the existing `_sendAllData()` |
| `runIf` | `_sweepRunIfSkips(runId)` so a newly added step resolves its gate immediately |

No artifact deletion on this path: a step qualifying as safe has never run, so it produced
nothing.

## Blocking path — modal and reset

Modal contents:

- Message: the flow was edited in a part that has already run.
- Detail: one line per affected run (run name / id) listing the blocking step ids and why
  (added / removed / modified), followed by: saving requires resetting the run — its artifacts,
  audit log, report and review reports are deleted and the run restarts from scratch.
- Buttons: **Reset & Save** | **Cancel**

**Cancel** (including dismissing the modal): return before `configManager.saveFlow`. Nothing on
disk or in memory changes. Post `flowSaveCancelled` carrying the submitted flow so the webview
reopens the builder with the user's draft — `saveEditingFlow`
(`packages/webview/src/hooks/useAppLogic.ts:725`) clears `editingFlow` as soon as it posts, so
without this the edit is lost.

**Reset & Save**: write the file first, then per live run set `rc.flow = newFlow` and call
`resetRun(runId)`. `resetRun` already kills the run's children, deletes artifacts and the run
output directory, clears the audit log, run file, report and review reports, and mints a fresh
runId whose state is initialised from the (now new) flow.

Required change to `resetRun`: it collects artifacts from `flow.steps.map(s => s.id)` of the
current flow, so a step deleted by the edit leaves its artifacts behind. Add an optional
`extraStepIds` parameter carrying ids that exist only in the old flow, and include them when
gathering produced files.

## Testing

`packages/core/test/flowEditImpact.test.ts` (pure, no vscode stub):

- append a step at the end while a middle step runs → safe
- insert a step as a new dependency of the running step → blocking
- modify the agent/prompt of a completed step → blocking
- remove a step that never ran → safe, `removed` reports the id
- remove the running step → blocking
- repoint `dependsOn` of a not-yet-started step to the new step → safe
- rename the flow with a completed step present → blocking; rename with nothing started → safe
- change `flow.inputs` with a completed step → blocking
- run with no progressed step → every edit safe

`packages/extension/test/unit/runOrchestrator.test.ts` (existing stub harness):

- `syncFlowIntoLiveRuns` adds/removes the right run-state entries, re-applies locks, persists via
  `saveRun`, and clears the removed steps' audit entries
- `syncFlowIntoLiveRuns` leaves closed runs and runs of other flows alone
- `resetRunsForFlow` resets every live run of the flow and skips closed ones
- `resetRun` with `extraStepIds` also deletes the removed step's artifacts

## Out of scope

- Runs already closed or finished (`isClosed`) are never touched — their history stays as
  recorded.
- No partial "reset from the affected step onward" mode; the confirmed reset is whole-run.

## Known limitations

- **The gate only sees runs resident in this window.** `_liveRunsOfFlow` filters `RunOrchestrator._runs`,
  which holds runs created or opened in this session. A flow edited in another VS Code window, or
  hand-edited on disk, never reaches this code path, so its live runs are neither assessed nor
  reconciled. What a persisted run does get, when it is later paired with a flow, is a step-map
  reconciliation (`reconcileRunSteps` in `_newRunCtx`): flow steps missing from the state gain a
  fresh entry, orphan entries are dropped, and dependency locks are re-applied — enough that no
  transition is silently dropped. It is deliberately *not* a reset or a re-prompt: an edit made
  while a run was not resident is outside what this design decided.
- **The `trustLevel` blocking clause is currently unreachable.** `assessFlowEdit` treats a changed
  `flow.trustLevel` as blocking, but `ConfigManager.saveFlow` never writes that field today, so an
  edit can never differ on it. The rule is kept because it is correct the moment the field becomes
  writable.
- **Manual verification must cover all three save call sites.** The script in `task-5-report.md`
  exercises the flow builder's Save only. Two other call sites post `saveFlow` and hit exactly the
  same gate, with different cancel behaviour: the step editor opened from the run board
  (`saveStepEdit` with `stepEditFromBoard`), and the board-level step removal (`onRemoveStep` in
  `App.tsx`, which has no editor open — a refusal there must leave the view untouched rather than
  opening a builder). Both need to be walked through the reset and the cancel branch.
