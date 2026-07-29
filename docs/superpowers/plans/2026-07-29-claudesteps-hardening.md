# ClaudeSteps Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise test coverage on the untested god-files, then shrink those files by extracting the pure logic the new tests pin — with zero behavior change.

**Architecture:** Test-first → refactor. For each target, extract pure logic (no React / no VS Code deps) into a new module, unit-test it with `node:test`, then have the original file import it back. A green suite before and after each extraction is the proof of no behavior change.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict`, c8 coverage, esbuild bundling, VS Code extension host (integration).

## Global Constraints

- Node `>=20`; extension targets VS Code `^1.93.0`.
- Extension ships with **zero runtime deps** except `@claudesteps/core` — do not add dependencies.
- No behavior change in any refactor task: `npm test` and all coverage gates stay green.
- Surgical changes only — touch only the files each task names; no unrelated formatting churn.
- Test runner: `node:test` + `node:assert/strict` (match existing suites). No new test framework.
- Webview pure modules must have no `react` import so they compile under `packages/webview/test/tsconfig.json` and run in bare Node.

---

## Phase 1 — Webview: extract `useAppLogic` pure logic + tests

### Task 1: Extract pure host-message helpers into `hostMessageReducers.ts`

**Files:**
- Create: `packages/webview/src/hooks/appState/hostMessageReducers.ts`
- Test: `packages/webview/test/hostMessageReducers.test.ts`
- Modify: `packages/webview/test/tsconfig.json` (add the new src file to `include`)

**Interfaces:**
- Produces:
  - `parseScopeFilter(v: string | undefined): ScopeFilter` — `'all'|'project'|'global'`, default `'all'`.
  - `parseViewFilter(v: unknown): ViewFilter` — array of `'built-in'`; migrates the old string form; else `[]`.
  - `parseSortOrder(v: string | undefined): SortOrder` — passes `'desc'|'asc'|'newest'|'oldest'`, else `'activity'`.
  - `parseGroupBy(v: string | undefined): 'list' | 'tag'` — `'tag'` iff `v === 'tag'`.
  - `dropKey<T>(map: Record<string, T>, key: string): Record<string, T>` — returns a new map without `key`.
  - `appendOutput(prev: string | undefined, chunk: string | undefined, append: boolean): string` — `append ? (prev||'')+(chunk||'') : (chunk||'')`.
  - `computeRunAggregate(changed: FlowRunState): RunAggregate` — the run-summary rollup (completed/inProgress/reviewing/failed/total steps, costUsd, tokensUsed, taskTimeMs, reviewTimeMs).
  - `type RunAggregate = { completedSteps: number; inProgressSteps: number; reviewing: boolean; failedSteps: number; totalSteps: number; costUsd: number; tokensUsed: number; taskTimeMs: number; reviewTimeMs: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/webview/test/hostMessageReducers.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScopeFilter, parseViewFilter, parseSortOrder, parseGroupBy,
  dropKey, appendOutput, computeRunAggregate
} from '../src/hooks/appState/hostMessageReducers.js';

test('parseScopeFilter validates against the allowed set', () => {
  assert.equal(parseScopeFilter('project'), 'project');
  assert.equal(parseScopeFilter('global'), 'global');
  assert.equal(parseScopeFilter('all'), 'all');
  assert.equal(parseScopeFilter(undefined), 'all');
  assert.equal(parseScopeFilter('garbage'), 'all');
});

test('parseViewFilter keeps built-in, migrates the old string, drops junk', () => {
  assert.deepEqual(parseViewFilter(['built-in']), ['built-in']);
  assert.deepEqual(parseViewFilter(['built-in', 'x']), ['built-in']);
  assert.deepEqual(parseViewFilter('built-in'), ['built-in']); // migrate old persisted string
  assert.deepEqual(parseViewFilter(undefined), []);
});

test('parseSortOrder passes known orders, else falls back to activity', () => {
  for (const v of ['desc', 'asc', 'newest', 'oldest']) assert.equal(parseSortOrder(v), v);
  assert.equal(parseSortOrder(undefined), 'activity');
  assert.equal(parseSortOrder('weird'), 'activity');
});

test('parseGroupBy is tag only for the literal tag', () => {
  assert.equal(parseGroupBy('tag'), 'tag');
  assert.equal(parseGroupBy('list'), 'list');
  assert.equal(parseGroupBy(undefined), 'list');
});

test('dropKey returns a new map without the key and never mutates the input', () => {
  const map = { a: 1, b: 2 };
  const out = dropKey(map, 'a');
  assert.deepEqual(out, { b: 2 });
  assert.deepEqual(map, { a: 1, b: 2 }); // input untouched
  assert.deepEqual(dropKey(map, 'missing'), { a: 1, b: 2 }); // absent key is a no-op copy
});

test('appendOutput appends or replaces based on the flag', () => {
  assert.equal(appendOutput('foo', 'bar', true), 'foobar');
  assert.equal(appendOutput('foo', 'bar', false), 'bar');
  assert.equal(appendOutput(undefined, undefined, true), '');
  assert.equal(appendOutput(undefined, 'x', false), 'x');
});

test('computeRunAggregate rolls up steps, cost, tokens and durations', () => {
  const changed: any = {
    steps: {
      s1: { completionStatus: 'done', executionStatus: 'completed', reviewStatus: 'approved',
            costUsd: 0.5, tokensUsed: 100,
            startedAt: '2026-07-29T00:00:00.000Z', completedAt: '2026-07-29T00:00:02.000Z',
            reviewCompletedAt: '2026-07-29T00:00:03.000Z' },
      s2: { completionStatus: 'not_ready', executionStatus: 'running', reviewStatus: 'pending',
            costUsd: 0.25, tokensUsed: 40 },
      s3: { completionStatus: 'not_ready', executionStatus: 'failed', reviewStatus: 'pending' }
    }
  };
  const agg = computeRunAggregate(changed);
  assert.equal(agg.completedSteps, 1);
  assert.equal(agg.inProgressSteps, 1);   // s2 running
  assert.equal(agg.failedSteps, 1);       // s3 failed
  assert.equal(agg.totalSteps, 3);
  assert.equal(agg.reviewing, false);
  assert.equal(agg.costUsd, 0.75);
  assert.equal(agg.tokensUsed, 140);
  assert.equal(agg.taskTimeMs, 2000);     // s1 started→completed
  assert.equal(agg.reviewTimeMs, 1000);   // s1 completed→reviewCompleted
});

test('computeRunAggregate flags reviewing when a step waits for review', () => {
  const changed: any = { steps: { s: { completionStatus: 'not_ready', executionStatus: 'completed', reviewStatus: 'waiting_human' } } };
  const agg = computeRunAggregate(changed);
  assert.equal(agg.reviewing, true);
  assert.equal(agg.inProgressSteps, 1);   // reviewing counts as in-progress
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run compile:webview-test && node --test packages/webview/out-test/test/hostMessageReducers.test.js`
Expected: FAIL — module `hostMessageReducers.js` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/webview/src/hooks/appState/hostMessageReducers.ts
import { FlowRunState } from '@claudesteps/core/types';
import { ScopeFilter, ViewFilter, ViewFilterItem, SortOrder } from './types';

const VALID_FILTERS: ScopeFilter[] = ['all', 'project', 'global'];

export const parseScopeFilter = (v: string | undefined): ScopeFilter =>
  VALID_FILTERS.includes(v as ScopeFilter) ? (v as ScopeFilter) : 'all';

export const parseViewFilter = (v: unknown): ViewFilter => {
  if (Array.isArray(v)) return (v as string[]).filter((x): x is ViewFilterItem => x === 'built-in');
  if (v === 'built-in') return [v]; // migrate old persisted string
  return [];
};

export const parseSortOrder = (v: string | undefined): SortOrder =>
  v === 'desc' || v === 'asc' || v === 'newest' || v === 'oldest' ? v : 'activity';

export const parseGroupBy = (v: string | undefined): 'list' | 'tag' => (v === 'tag' ? 'tag' : 'list');

export const dropKey = <T>(map: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _drop, ...rest } = map;
  return rest;
};

export const appendOutput = (prev: string | undefined, chunk: string | undefined, append: boolean): string =>
  append ? `${prev || ''}${chunk || ''}` : (chunk || '');

export type RunAggregate = {
  completedSteps: number; inProgressSteps: number; reviewing: boolean; failedSteps: number;
  totalSteps: number; costUsd: number; tokensUsed: number; taskTimeMs: number; reviewTimeMs: number;
};

export const computeRunAggregate = (changed: FlowRunState): RunAggregate => {
  const steps = Object.values(changed.steps || {}) as any[];
  const span = (from?: string, to?: string) => {
    if (!from || !to) return 0;
    const ms = new Date(to).getTime() - new Date(from).getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  };
  const isReviewing = (s: any) => s.reviewStatus === 'ai_review_running' || s.reviewStatus === 'waiting_human';
  return {
    completedSteps: steps.filter(s => s.completionStatus === 'done').length,
    inProgressSteps: steps.filter(s => s.executionStatus === 'running' || isReviewing(s)).length,
    reviewing: steps.some(isReviewing),
    failedSteps: steps.filter(s => s.executionStatus === 'failed').length,
    totalSteps: steps.length,
    costUsd: steps.reduce((t, s) => t + (s.costUsd ?? 0), 0),
    tokensUsed: steps.reduce((t, s) => t + (s.tokensUsed ?? 0), 0),
    taskTimeMs: steps.reduce((t, s) => t + span(s.startedAt, s.completedAt), 0),
    reviewTimeMs: steps.reduce((t, s) => t + span(s.completedAt, s.reviewCompletedAt), 0)
  };
};
```

Then add the new file to the test tsconfig `include` array in `packages/webview/test/tsconfig.json`:
`"../src/hooks/appState/hostMessageReducers.ts"` (and its transitive `./types`, `@claudesteps/core/types` already resolve via NodeNext).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run compile:webview-test && node --test packages/webview/out-test/test/hostMessageReducers.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/webview/src/hooks/appState/hostMessageReducers.ts packages/webview/test/hostMessageReducers.test.ts packages/webview/test/tsconfig.json
git commit -m "test(webview): add pure host-message reducers with unit tests"
```

### Task 2: Rewire `useAppLogic` to consume the extracted helpers

**Files:**
- Modify: `packages/webview/src/hooks/useAppLogic.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.

- [ ] **Step 1: Replace the inline helpers with imports**

In `useAppLogic.ts`:
- Delete the top-of-file `VALID_FILTERS` const and `parseFilter` (lines 18-20); import `parseScopeFilter as parseFilter` from `./appState/hostMessageReducers`.
- In `loadData`, delete the inline `parseViewFilter`, `parseSortOrder`, `parseGroupBy` closures (lines 153-172) and import them from the reducers module instead.
- In `runStateChanged` (lines 334-354) replace the inline `span`/`isReviewing`/`agg` block with `const agg = computeRunAggregate(changed);`.
- In `stepUpdate` (line 293) replace the inline ternary with `const output = appendOutput(ps?.output, message.output, message.append);`.
- In `aiReviewUpdate` (line 305) replace with `const aiReviewOutput = appendOutput(ps?.aiReviewOutput, message.output, message.append);`.
- Replace the `const { [x]: _drop, ...rest } = prev; return rest;` drawer-drop idioms in `restoreRun`, `runDeleted`, `runClosed`, and `collapseRun` with `dropKey(prev, x)`.

- [ ] **Step 2: Compile and run the full webview suite**

Run: `npm run test:webview`
Expected: PASS — existing `flowUtils`/`tagUtils` tests plus `hostMessageReducers` all green; no behavior change.

- [ ] **Step 3: Type-check the webview build**

Run: `npm run build-webview`
Expected: esbuild succeeds with no type/import errors.

- [ ] **Step 4: Commit**

```bash
git add packages/webview/src/hooks/useAppLogic.ts
git commit -m "refactor(webview): use extracted host-message reducers in useAppLogic"
```

### Task 3: Add a webview coverage gate

**Files:**
- Create: `.c8rc.webview.json`
- Modify: `package.json` (add `test:coverage-webview` script; wire into CI later)
- Modify: `.github/workflows/ci.yml` (add a coverage-webview step)

**Interfaces:**
- Consumes: the compiled `packages/webview/out-test` output from `compile:webview-test`.

- [ ] **Step 1: Create the c8 config (gates only what the suite actually covers)**

```json
// .c8rc.webview.json
{
  "all": true,
  "//": "Gates only the pure webview modules the unit suite covers. React components stay out until they have tests; adding a module here is a deliberate act.",
  "include": [
    "packages/webview/out-test/src/flowUtils.js",
    "packages/webview/out-test/src/tagUtils.js",
    "packages/webview/out-test/src/hooks/appState/hostMessageReducers.js"
  ],
  "reporter": ["text", "text-summary"],
  "check-coverage": true,
  "lines": 85,
  "branches": 75,
  "functions": 85
}
```

- [ ] **Step 2: Add the script**

In `package.json` scripts, add:
```json
"test:coverage-webview": "npm run compile && npm run compile:webview-test && c8 --config .c8rc.webview.json node --test packages/webview/out-test/test/*.test.js"
```

- [ ] **Step 3: Run the gate**

Run: `npm run test:coverage-webview`
Expected: PASS with all three files at/above thresholds. If a threshold is unmet, lower it to the true covered value rather than faking coverage — never gate above reality.

- [ ] **Step 4: Wire into CI**

In `.github/workflows/ci.yml`, after the extension coverage step add:
```yaml
      - name: Coverage (webview pure modules, gated)
        run: npm run test:coverage-webview
```

- [ ] **Step 5: Commit**

```bash
git add .c8rc.webview.json package.json .github/workflows/ci.yml
git commit -m "test(webview): gate coverage on the pure webview modules"
```

---

## Phase 2 — Extension: concurrent-run routing helpers + tests

### Task 4: Extract run-keying helpers into `runOrchestratorHelpers.ts`

**Files:**
- Create: `packages/extension/src/runOrchestratorHelpers.ts`
- Test: `packages/extension/test/unit/runOrchestratorHelpers.test.ts`
- Modify: `packages/extension/src/runOrchestrator.ts` (use the helpers; delete the inlined `_rk` body)
- Modify: `.c8rc.extension.json` (add the new module to `include`)

**Interfaces:**
- Produces:
  - `runKey(runId: string, stepId: string): string` — `` `${runId}::${stepId}` `` (matches current `_rk`).
  - `isRunKeyOf(key: string, runId: string): boolean` — true iff `key` starts with `` `${runId}::` ``.
  - `purgeRunKeys<T>(map: Map<string, T>, runId: string): string[]` — deletes every entry whose key belongs to `runId`; returns the deleted keys. (Pure over the Map it is handed.)

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/test/unit/runOrchestratorHelpers.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runKey, isRunKeyOf, purgeRunKeys } from '../../src/runOrchestratorHelpers.js';

test('runKey namespaces a step under its run so two runs never collide', () => {
  assert.equal(runKey('runA', 'implement'), 'runA::implement');
  assert.notEqual(runKey('runA', 'implement'), runKey('runB', 'implement'));
});

test('isRunKeyOf matches only keys of the given run', () => {
  assert.equal(isRunKeyOf('runA::implement', 'runA'), true);
  assert.equal(isRunKeyOf('runB::implement', 'runA'), false);
  // a runId that is a prefix of another must not false-match
  assert.equal(isRunKeyOf('runA10::x', 'runA1'), false);
});

test('purgeRunKeys removes only the target run and reports what it removed', () => {
  const m = new Map<string, number>([
    ['runA::a', 1], ['runA::b', 2], ['runB::a', 3]
  ]);
  const removed = purgeRunKeys(m, 'runA').sort();
  assert.deepEqual(removed, ['runA::a', 'runA::b']);
  assert.deepEqual([...m.keys()], ['runB::a']); // runB survives
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run compile:unit-ext && node --test packages/extension/out-unit/test/unit/runOrchestratorHelpers.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/extension/src/runOrchestratorHelpers.ts
export const runKey = (runId: string, stepId: string): string => `${runId}::${stepId}`;

export const isRunKeyOf = (key: string, runId: string): boolean => key.startsWith(`${runId}::`);

export const purgeRunKeys = <T>(map: Map<string, T>, runId: string): string[] => {
  const removed: string[] = [];
  for (const key of map.keys()) if (isRunKeyOf(key, runId)) removed.push(key);
  for (const key of removed) map.delete(key);
  return removed;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run compile:unit-ext && node --test packages/extension/out-unit/test/unit/runOrchestratorHelpers.test.js`
Expected: PASS.

- [ ] **Step 5: Rewire `runOrchestrator.ts` to use `runKey`**

Replace the private `_rk` (line 93) body with `return runKey(runId, stepId);` and import `runKey` at the top; leave `_rk` as a thin delegator (keeps call sites unchanged). If `_purgeRunKeys` (line 449) iterates keys manually and its backing store is a `Map`, delegate it to `purgeRunKeys`; otherwise leave `_purgeRunKeys` as-is (do not change behavior to fit the helper).

- [ ] **Step 6: Run the full extension unit suite + build**

Run: `npm run test:unit-ext && npm run compile`
Expected: PASS — no behavior change.

- [ ] **Step 7: Gate the new module**

Add `"packages/extension/out-unit/src/runOrchestratorHelpers.js"` to the `include` array in `.c8rc.extension.json`, then run `npm run test:coverage-ext`. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/extension/src/runOrchestratorHelpers.ts packages/extension/test/unit/runOrchestratorHelpers.test.ts packages/extension/src/runOrchestrator.ts .c8rc.extension.json
git commit -m "test(extension): extract and cover per-run keying helpers"
```

---

## Phase 3 — Split god-files (only after Phases 1–2 land)

> Each Phase-3 task is a pure move-and-reexport. The correctness proof is the full suite staying green — run `npm test` (and `npm run test:integration` for the extension host) after each. Do not change any behavior.

### Task 5: Extract review-gate logic from `runOrchestrator.ts`

**Files:**
- Create: `packages/extension/src/runReview.ts`
- Modify: `packages/extension/src/runOrchestrator.ts:824-982` (`_reviewStep`, `_runAiReview`)

**Interfaces:**
- Produces: a `runReview` module exporting the review-gate functions as free functions that take the collaborators they need (run context, step, projectPath, notify/patch callbacks) as parameters, so `RunOrchestrator` calls them instead of owning the bodies.

- [ ] **Step 1: Map the exact dependency surface**

Read `_reviewStep` and `_runAiReview` (lines 824-982). List every `this.*` they touch (e.g. `this._patchStepState`, `this._spawnClaudeStreaming`, `this._notify`, `this._withRun`). These become explicit parameters of the extracted functions.

- [ ] **Step 2: Move the bodies into `runReview.ts` as free functions**

Signature shape:
```ts
// packages/extension/src/runReview.ts
export async function runAiReview(deps: {
  runId: string; step: FlowStep; stepId: string; projectPath: string;
  patchStepState: (runId: string, stepId: string, patch: Partial<StepRunState>) => Promise<void>;
  spawnClaudeStreaming: (opts: ClaudeStreamingRunOptions, stepId?: string, isGeneration?: boolean) => Promise<ClaudeStreamingRunResult>;
  notify: (level: 'info' | 'warn' | 'error', message: string) => void;
  // ...only the collaborators the body actually uses, from Step 1's list
}): Promise<void> { /* moved body, this.X → deps.X */ }
```
Keep `_runAiReview`/`_reviewStep` on the class as thin wrappers that call the free functions with `this`-bound collaborators — call sites and behavior unchanged.

- [ ] **Step 3: Run the full suite**

Run: `npm test && npm run compile`
Expected: PASS. Then `xvfb`-less locally: `npm run test:integration` if a display is available; otherwise rely on CI's integration job.

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/runReview.ts packages/extension/src/runOrchestrator.ts
git commit -m "refactor(extension): extract review-gate logic into runReview"
```

### Task 6: Extract pure config/validation helpers from `runOrchestrator.ts`

**Files:**
- Modify: `packages/extension/src/runOrchestratorHelpers.ts` (add pure helpers)
- Modify: `packages/extension/src/runOrchestrator.ts` (`_runTimeoutMs` 984, `_runMaxTurns` 990, `_runSlug` 1035, `_legacyRunSlug` 1042, `_validateRequires` 1068, `_validateProduces` 1074)
- Test: `packages/extension/test/unit/runOrchestratorHelpers.test.ts` (extend)

**Interfaces:**
- Produces (add to `runOrchestratorHelpers.ts`):
  - `runSlug(runId: string): string` and `legacyRunSlug(runId: string): string` — filesystem-safe slug of a runId (copy current logic verbatim).
  - `runMaxTurns(configured: number | undefined, agentMax: number | undefined, fallback: number): number` — the precedence the class currently applies.

- [ ] **Step 1: Write failing tests for the pure ones**

Read the current bodies first, then assert their exact behavior (examples — replace values with the real logic once read):
```ts
test('runSlug is filesystem-safe and stable', () => {
  assert.match(runSlug('2026-07-29T00:00:00.000Z'), /^[A-Za-z0-9._-]+$/);
  assert.equal(runSlug('a/b:c'), runSlug('a/b:c')); // deterministic
});
```

- [ ] **Step 2: Run to verify it fails, then move the pure bodies over, delegating from the class**

`_runSlug`/`_legacyRunSlug`/`_runMaxTurns` become one-line delegators to the module. Leave `_validateRequires`/`_validateProduces` in place if they depend on `this` filesystem state — only extract what is genuinely pure (slug + maxTurns). Do not force impure logic into the pure module.

- [ ] **Step 3: Run tests + full suite**

Run: `npm run test:coverage-ext && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/runOrchestratorHelpers.ts packages/extension/src/runOrchestrator.ts packages/extension/test/unit/runOrchestratorHelpers.test.ts
git commit -m "refactor(extension): extract pure run slug/turns helpers with tests"
```

### Task 7: Extract bundled-library management from `configManager.ts`

**Files:**
- Create: `packages/extension/src/bundledLibrary.ts`
- Modify: `packages/extension/src/configManager.ts` (`installBundledDefaults` 314, `pruneRenamedDefaults` 410, `pruneRenamedSkillFolders` 430, `recordInstallRoot` 389, `listBundledDefaults` 101, `_firstHeading` 142, `_firstJsComment` 147)
- Test: `packages/extension/test/unit/bundledLibrary.test.ts`

**Interfaces:**
- Produces:
  - `firstHeading(md: string): string` — first `#`/`##` heading text, else `''` (copy current logic).
  - `firstJsComment(js: string): string` — first leading comment text (copy current logic).
  - Keep the fs-touching install/prune functions as free functions taking their target dirs + fs deps as params; `ConfigManager` delegates.

- [ ] **Step 1: Write failing tests for the pure text parsers**

```ts
// packages/extension/test/unit/bundledLibrary.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstHeading, firstJsComment } from '../../src/bundledLibrary.js';

test('firstHeading returns the first markdown heading text', () => {
  assert.equal(firstHeading('# Title\n\nbody'), 'Title');
  assert.equal(firstHeading('no heading here'), '');
});

test('firstJsComment returns the leading comment text', () => {
  assert.equal(firstJsComment('// hello\ncode();'), 'hello');
  assert.equal(firstJsComment('code();'), '');
});
```
(Adjust the exact expected strings after reading the real `_firstHeading`/`_firstJsComment` bodies — assert their true behavior, do not invent it.)

- [ ] **Step 2: Verify fail, move the two pure parsers, delegate the class methods**

`ConfigManager._firstHeading`/`_firstJsComment` become one-line delegators. Move the install/prune group into `bundledLibrary.ts` as free functions only if they extract cleanly with explicit params; otherwise leave them and split just the pure parsers this round (Simplicity First — do not over-extract).

- [ ] **Step 3: Run tests + full suite**

Run: `npm run test:unit-ext && npm test && npm run compile`
Expected: PASS. `configManager.test.ts` (existing) must stay green — proof the delegation preserved behavior.

- [ ] **Step 4: Gate + commit**

Add `bundledLibrary.js` to `.c8rc.extension.json` include, run `npm run test:coverage-ext`, then:
```bash
git add packages/extension/src/bundledLibrary.ts packages/extension/src/configManager.ts packages/extension/test/unit/bundledLibrary.test.ts .c8rc.extension.json
git commit -m "refactor(extension): extract bundled-library text parsers with tests"
```

### Task 8: Extract the `webviewPanel._dispatch` router + generation helpers

**Files:**
- Create: `packages/extension/src/webviewGeneration.ts`
- Modify: `packages/extension/src/webviewPanel.ts` (`_runGenerationPrompt` 446, `_handleGenerateDraft` 467, `_handleGenerateFlow` 527, `_normalizeFlowInputs` 594, `_normalizeGeneratedSteps` 609)
- Test: `packages/extension/test/unit/webviewGeneration.test.ts`

**Interfaces:**
- Produces:
  - `normalizeFlowInputs(inputs: unknown): Flow['inputs']` — pure (copy current logic).
  - `normalizeGeneratedSteps(steps: unknown[], agentNames: Set<string>, skillNames: Set<string>): FlowStep[]` — pure (copy current logic).

- [ ] **Step 1: Write failing tests for the two pure normalizers**

```ts
// packages/extension/test/unit/webviewGeneration.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFlowInputs, normalizeGeneratedSteps } from '../../src/webviewGeneration.js';

test('normalizeFlowInputs coerces junk to a clean inputs record', () => {
  // assert the real behavior after reading _normalizeFlowInputs (e.g. undefined → {})
  assert.deepEqual(normalizeFlowInputs(undefined), {});
});

test('normalizeGeneratedSteps drops steps whose agent/skill is unknown', () => {
  const agents = new Set(['a']); const skills = new Set(['s']);
  const out = normalizeGeneratedSteps([{ id: 'x', agent: 'a', skills: ['s'] }], agents, skills);
  assert.equal(out.length, 1);
  assert.equal(out[0].agent, 'a');
});
```
(Finalize expected values against the real bodies before implementing.)

- [ ] **Step 2: Verify fail, move both pure normalizers into `webviewGeneration.ts`, delegate from the panel**

`CockpitPanel._normalizeFlowInputs`/`_normalizeGeneratedSteps` become one-line delegators. The fs/host-touching generation methods (`_runGenerationPrompt` etc.) may also move if they take explicit deps cleanly; otherwise leave them this round.

- [ ] **Step 3: Run tests + full suite**

Run: `npm run test:unit-ext && npm test && npm run compile`
Expected: PASS.

- [ ] **Step 4: Gate + commit**

Add `webviewGeneration.js` to `.c8rc.extension.json` include, run `npm run test:coverage-ext`, then:
```bash
git add packages/extension/src/webviewGeneration.ts packages/extension/src/webviewPanel.ts packages/extension/test/unit/webviewGeneration.test.ts .c8rc.extension.json
git commit -m "refactor(extension): extract flow-generation normalizers with tests"
```

### Task 9: Split `sidebarHtml.ts` into fragments (light test)

**Files:**
- Modify: `packages/extension/src/sidebarHtml.ts`
- Test: `packages/extension/test/unit/sidebarHtml.test.ts`

**Interfaces:**
- Produces: `getSidebarHtml(webview, extensionUri, version)` unchanged signature; internally composed from private fragment builders (`head`, `styles`, `body`, `script`).

- [ ] **Step 1: Write the light guard test first**

```ts
// packages/extension/test/unit/sidebarHtml.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSidebarHtml } from '../../src/sidebarHtml.js';
import { recorder } from './vscodeStub.js'; // if a webview stub with cspSource/asWebviewUri is needed

test('sidebar html wires CSP, a nonce, and the version', () => {
  const webview: any = {
    cspSource: 'vscode-webview://x',
    asWebviewUri: (u: any) => u,
    // add whatever getSidebarHtml reads, from reading the current source
  };
  const html = getSidebarHtml(webview, { fsPath: '/ext' } as any, '9.9.9');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /nonce-/);              // a nonce is injected
  assert.match(html, /9\.9\.9/);             // version rendered
});
```
(Read `getSidebarHtml` first to build a webview stub that satisfies exactly what it calls — no more.)

- [ ] **Step 2: Verify it passes against the current single function (baseline)**

Run: `npm run compile:unit-ext && node --test packages/extension/out-unit/test/unit/sidebarHtml.test.js`
Expected: PASS — this pins current output before the split.

- [ ] **Step 3: Split into private fragment builders, recompose in `getSidebarHtml`**

Extract `renderHead(...)`, `renderStyles()`, `renderBody()`, `renderScript(nonce)` as module-private functions; `getSidebarHtml` concatenates them. No output change.

- [ ] **Step 4: Re-run the guard test + full suite**

Run: `npm run test:unit-ext && npm test`
Expected: PASS — identical CSP/nonce/version markers.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidebarHtml.ts packages/extension/test/unit/sidebarHtml.test.ts
git commit -m "refactor(extension): split sidebar html into fragments with a guard test"
```

---

## Self-Review notes

- **Spec coverage:** Phase 1 → Tasks 1-3 (useAppLogic extraction + webview gate). Phase 2 → Task 4 (concurrent-run keying). Phase 3 → Tasks 5-9 (runOrchestrator ×2, configManager, webviewPanel, sidebarHtml). All spec sections covered.
- **No placeholders in code that ships:** the reducer module (Task 1) and run-keying helpers (Task 4) carry full implementations. Phase-3 tasks that copy existing bodies say "read the real body first, assert its true behavior" — the plan must not invent behavior it hasn't read; that is a deliberate instruction, not a placeholder.
- **Type consistency:** `parseScopeFilter` (module) aliased to `parseFilter` at the useAppLogic call site; `runKey`/`isRunKeyOf`/`purgeRunKeys` names are stable across Tasks 4 and 6; `computeRunAggregate`/`RunAggregate` stable across Tasks 1-2.
- **Ordering safety:** Phase 3 refactors run only after their guarding tests exist (Phase 1/2 or the same task's Step 1).
