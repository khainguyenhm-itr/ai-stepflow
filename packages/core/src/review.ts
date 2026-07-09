/**
 * Shared two-layer artifact review, used by BOTH the extension and the CLI so a step is judged
 * the same way no matter where it runs:
 *   1) a deterministic validator (.mjs) — cheap, certain (exists / non-empty / no TODO);
 *   2) an optional LLM reviewer that reads the produced artifacts against a review-kit prompt.
 *
 * The LLM call is injected as a {@link StepRunner}, so this module stays pure I/O-wise and is
 * unit-testable with a stub runner. The caller gathers the artifacts + kit text (via the helpers
 * here) and applies the returned verdict to the run state.
 */

import * as os from 'os';
import * as path from 'path';
import { readFileSync, statSync } from 'fs';
import { FlowRunState, FlowStep } from './types.js';
import { StepRunner } from './claudeRunner.js';
import { runValidator } from './validatorRunner.js';
import { parseVerdict, parseReviewFindings } from './runUtils.js';
import { resolveTemplates, runOutputSlug } from './pathTemplates.js';
import { locateProducedFile } from './artifactLocator.js';

/** Layer-1 validator applied to AI reviews that don't name their own `validatorPath`. */
export const DEFAULT_REVIEW_VALIDATOR = 'aisf-produces-complete.mjs';
/** Layer-2 LLM review prompt (adapts to the produced artifact's type). */
export const DEFAULT_REVIEW_KIT = 'aisf-review-default.md';
/** Verifying an artifact is light work — default the reviewer to a small, cheap model. */
export const DEFAULT_REVIEW_MODEL = 'haiku';
/** Cap per-file content fed to the LLM reviewer so a large artifact can't blow up the prompt. */
export const REVIEW_ARTIFACT_CHAR_CAP = 3000;
/** Cap the combined review payload across all produced files. */
export const REVIEW_TOTAL_CHAR_CAP = 12000;

/**
 * Truncate `content` to `maxChars` while preserving both the head and the tail of the
 * file. A naive `slice(0, max)` discards the end — often the most informative part
 * (function return values, test assertions, exports). This variant keeps 60 % from the
 * head (imports, type declarations) and 40 % from the tail (results, exports), joined
 * by a clear ellipsis marker so the reviewer knows content was omitted.
 */
export function smartTruncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize - 20; // 20 chars for the ellipsis line
  const head = content.slice(0, headSize);
  const tail = content.slice(-tailSize);
  return `${head}\n…[middle truncated]…\n${tail}`;
}

export interface ReviewResult {
  status: 'approved' | 'rejected' | 'waiting_human';
  note: string;
  /** Which layer produced the verdict — useful for logging/audit. */
  source: 'freshness' | 'validator' | 'validator-only' | 'llm' | 'review-setup';
  /** Usage from the LLM review call; absent for validator-only or skipped paths. */
  reviewTokensUsed?: number;
  reviewCostUsd?: number;
  /** LLM findings for the review report: what's correct, what's wrong, and how to fix it. */
  correct?: string[];
  issues?: string[];
  suggestions?: string[];
}

/** Resolve and read a step's produced files into one capped payload for the LLM reviewer. */
export function readProducedArtifacts(
  step: FlowStep,
  workspaceRoot: string,
  inputs: Record<string, string>,
  flowName = '',
  runSlug = ''
): { text: string; count: number } {
  const reviewPath = step.review.filePath ? [step.review.filePath] : [];
  const paths = resolveTemplates([...reviewPath, ...(step.produces ?? [])], inputs)
    .map(p => locateProducedFile(p, flowName, workspaceRoot, runSlug));
  const seen = new Set<string>();
  const parts: string[] = [];
  let total = 0;
  for (const filePath of paths) {
    if (total >= REVIEW_TOTAL_CHAR_CAP) break;
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
    const room = Math.min(REVIEW_ARTIFACT_CHAR_CAP, REVIEW_TOTAL_CHAR_CAP - total);
    const slice = smartTruncate(content, room);
    const truncated = slice.length < content.length && !slice.includes('…[middle truncated]…') ? '\n…[truncated]' : '';
    parts.push(`=== ${filePath} ===\n${slice}${truncated}`);
    total += slice.length;
  }
  return { text: parts.join('\n\n'), count: parts.length };
}

/** Load the review-kit markdown, preferring a project copy over the global default; '' if absent. */
export function loadReviewKit(workspaceRoot: string, name = DEFAULT_REVIEW_KIT): string {
  const candidates = [path.join(workspaceRoot, '.claude', 'reviews', name), path.join(os.homedir(), '.claude', 'reviews', name)];
  for (const candidate of candidates) {
    try { return readFileSync(candidate, 'utf8'); } catch { /* try next */ }
  }
  return '';
}

export interface ReviewOptions {
  workspaceRoot: string;
  step: FlowStep;
  runState: FlowRunState;
  /** Run the layer-2 LLM review (typically `step.review.deep !== false`). */
  deep: boolean;
  /** The LLM review-kit prompt; '' to skip layer 2. Defaults to {@link loadReviewKit}. */
  reviewKit?: string;
  /** Produced-artifact payload for the LLM; defaults to {@link readProducedArtifacts}. */
  artifacts?: { text: string; count: number };
  /** Injected LLM runner (the headless claude call). Required for layer 2. */
  runner: StepRunner;
  /** Model for the review LLM call; defaults to {@link DEFAULT_REVIEW_MODEL}. */
  reviewModel?: string;
  /** Streams the reviewer's output to the caller. */
  onText?: (chunk: string) => void;
}

/**
 * Slack (ms) when comparing a produced file's mtime to the step start time. Absorbs filesystem
 * mtime granularity (some filesystems truncate to whole seconds) and small clock skew, so a file
 * genuinely written just after the step started is never mis-flagged as stale. Comfortably smaller
 * than the gap a real stale file (from a previous run, minutes/hours old) would show.
 */
export const FRESHNESS_TOLERANCE_MS = 2000;

/**
 * Return the first declared `produces` file that was NOT regenerated during this run — i.e. it
 * exists but was last modified more than {@link FRESHNESS_TOLERANCE_MS} before the step started.
 * Returns null when every declared produces file is fresh, none are declared, no start time is
 * known, or a file is missing (a missing file is left for the validator to report, with a clearer
 * message). This is the guard that stops an AI review from passing a stale/leftover artifact the
 * step did not actually (re)create.
 */
export function findStaleProducedFile(
  step: FlowStep,
  workspaceRoot: string,
  inputs: Record<string, string>,
  startedAtIso?: string,
  flowName = '',
  runSlug = ''
): string | null {
  const produces = step.produces ?? [];
  if (produces.length === 0 || !startedAtIso) return null;
  const startedMs = new Date(startedAtIso).getTime();
  if (!Number.isFinite(startedMs)) return null;
  const paths = resolveTemplates(produces, inputs).map(p => locateProducedFile(p, flowName, workspaceRoot, runSlug));
  for (const filePath of paths) {
    let mtimeMs: number;
    try { mtimeMs = statSync(filePath).mtimeMs; } catch { continue; } // missing → validator reports it
    if (mtimeMs < startedMs - FRESHNESS_TOLERANCE_MS) return filePath;
  }
  return null;
}

/**
 * Run the two-layer review and return a verdict. Layer 1 (validator) can short-circuit to
 * `rejected`; a missing *default* validator is treated as "skip layer 1" only when a deep
 * LLM review can still inspect the artifacts. Missing validator-only infrastructure or a
 * missing deep review payload waits for a human instead of silently approving.
 */
export async function reviewStepArtifacts(opts: ReviewOptions): Promise<ReviewResult> {
  const { workspaceRoot, step, runState } = opts;

  // Layer 0 — freshness: a declared produces file that exists but was not (re)written during this
  // run is stale (leftover from a prior run/attempt). Reject before spending validator/LLM effort,
  // so an AI review can never pass an artifact this step did not actually create.
  const stale = findStaleProducedFile(
    step, workspaceRoot, runState.inputs || {},
    runState.steps[step.id]?.startedAt, runState.flowName || '',
    runOutputSlug(runState.runName, runState.runId)
  );
  if (stale) {
    return { status: 'rejected', note: `Produced file was not regenerated by this run (stale): ${stale}`, source: 'freshness' };
  }

  // Layer 1 — deterministic validator.
  const explicitValidator = step.review.validatorPath;
  const verdict = await runValidator({ workspaceRoot, step, runState, stepOutput: '', validatorPath: explicitValidator || DEFAULT_REVIEW_VALIDATOR });
  const validatorMissing = !explicitValidator && verdict.decision === 'reject' && verdict.reason.startsWith('Failed to load');
  if (!validatorMissing && verdict.decision === 'reject') {
    return { status: 'rejected', note: `Validator: reject — ${verdict.reason}`, source: 'validator' };
  }
  if (!opts.deep) {
    if (validatorMissing) {
      return {
        status: 'waiting_human',
        note: `Validator-only review could not run: ${verdict.reason}`,
        source: 'review-setup'
      };
    }
    return { status: 'approved', note: 'Validator passed; LLM review skipped (deep review disabled).', source: 'validator-only' };
  }

  // Layer 2 — deep LLM review.
  const reviewKit = opts.reviewKit ?? loadReviewKit(workspaceRoot);
  const artifacts = opts.artifacts ?? readProducedArtifacts(step, workspaceRoot, runState.inputs || {}, runState.flowName || '', runOutputSlug(runState.runName, runState.runId));
  if (!reviewKit || artifacts.count === 0) {
    const reason = !reviewKit ? 'review kit not installed' : 'no produced artifacts to read';
    return { status: 'waiting_human', note: `Deep review could not run: ${reason}.`, source: 'review-setup' };
  }

  const systemPrompt = `${reviewKit}\n\nRespond with ONLY a single-line minified JSON object with these keys:\n{"decision":"pass"|"reject","reason":"<one-line summary>","correct":["<what the artifact gets right>"],"issues":["<what is wrong or missing>"],"suggestions":["<concrete fix for each issue>"]}.\nThe arrays may be empty but must always be present.`;
  const userMessage = `Review the artifact(s) produced by step "${step.title || step.id}".\n\n${artifacts.text}`;
  const result = await opts.runner({
    systemPrompt,
    userMessage,
    model: opts.reviewModel || DEFAULT_REVIEW_MODEL,
    projectPath: workspaceRoot,
    onText: opts.onText ?? (() => {})
  });

  const reviewMetrics = {
    reviewTokensUsed: result.tokensUsed,
    reviewCostUsd: result.costUsd,
  };
  const parsed = parseVerdict(result.resultText);
  if (!parsed) return { status: 'waiting_human', note: 'could not parse an automated verdict; waiting for human review', source: 'llm', ...reviewMetrics };
  const findings = parseReviewFindings(result.resultText);
  if (parsed.decision === 'pass') return { status: 'approved', note: parsed.reason || 'approved', source: 'llm', ...reviewMetrics, ...findings };
  return { status: 'rejected', note: parsed.reason || 'rejected', source: 'llm', ...reviewMetrics, ...findings };
}

// ---------------------------------------------------------------------------
// Review report rendering
// ---------------------------------------------------------------------------

/** ms between two ISO timestamps, or 0 if either is missing/invalid. */
function reviewSpanMs(from?: string, to?: string): number {
  if (!from || !to) return 0;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** Human-readable duration: "450ms", "12s", "1m 23s", "2h 5m"; "—" for 0. */
function reviewFmtDuration(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Make a string safe inside a Markdown table cell (escape pipes, flatten newlines). */
function reviewCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** Render a numbered Markdown table from a list, or an italic placeholder when empty. */
function reviewList(header: string, items: string[] | undefined): string {
  if (!items || items.length === 0) return '_None reported._';
  const rows = items.map((item, i) => `| ${i + 1} | ${reviewCell(item)} |`).join('\n');
  return `| # | ${header} |\n| --- | --- |\n${rows}`;
}

export interface ReviewReportInput {
  step: FlowStep;
  flowName?: string;
  runName?: string;
  runId: string;
  /** Which review layer produced the verdict. */
  source: string;
  /** One-line reason the step was rejected. */
  reason: string;
  correct?: string[];
  issues?: string[];
  suggestions?: string[];
  startedAt?: string;
  completedAt?: string;
  reviewCompletedAt?: string;
  tokensUsed?: number;
  costUsd?: number;
  modelUsed?: string;
}

/**
 * Render a human-readable Markdown AI-review report for a rejected step: a summary table (step,
 * timing, model, token/cost) followed by "what's correct", "issues", and "suggested fixes" tables.
 * Pure — the caller persists the returned string wherever it wants.
 */
export function renderReviewReport(input: ReviewReportInput): string {
  const title = input.step.title || input.step.id;
  const taskMs = reviewSpanMs(input.startedAt, input.completedAt);
  const reviewMs = reviewSpanMs(input.completedAt, input.reviewCompletedAt);
  const summary = [
    ['Step', `${reviewCell(title)} (\`${input.step.id}\`)`],
    ['Flow', reviewCell(input.flowName || '—')],
    ['Run', reviewCell(input.runName || input.runId)],
    ['Verdict', '❌ Rejected'],
    ['Review source', reviewCell(input.source)],
    ['Model', reviewCell(input.modelUsed || '—')],
    ['Started', reviewCell(input.startedAt || '—')],
    ['Completed', reviewCell(input.completedAt || '—')],
    ['Task time', reviewFmtDuration(taskMs)],
    ['Review time', reviewFmtDuration(reviewMs)],
    ['Tokens', input.tokensUsed != null ? input.tokensUsed.toLocaleString() : '—'],
    ['Cost', input.costUsd != null ? `$${input.costUsd.toFixed(4)}` : '—'],
    ['Generated', new Date().toISOString()],
  ].map(([k, v]) => `| ${k} | ${v} |`).join('\n');

  return [
    `# AI Review Report — ${title}`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    summary,
    '',
    '## Why it was rejected',
    '',
    reviewCell(input.reason) || '_No reason provided._',
    '',
    "## What's correct",
    '',
    reviewList('Correct', input.correct),
    '',
    '## Issues found',
    '',
    reviewList('Issue', input.issues),
    '',
    '## Suggested fixes',
    '',
    reviewList('Suggestion', input.suggestions),
    '',
  ].join('\n');
}
