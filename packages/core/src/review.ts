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
import { readFileSync } from 'fs';
import { FlowRunState, FlowStep } from './types.js';
import { StepRunner } from './claudeRunner.js';
import { runValidator } from './validatorRunner.js';
import { parseVerdict } from './runUtils.js';
import { resolveTemplates } from './pathTemplates.js';

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

export interface ReviewResult {
  status: 'approved' | 'rejected' | 'waiting_human';
  note: string;
  /** Which layer produced the verdict — useful for logging/audit. */
  source: 'validator' | 'validator-only' | 'llm';
}

/** Resolve and read a step's produced files into one capped payload for the LLM reviewer. */
export function readProducedArtifacts(
  step: FlowStep,
  workspaceRoot: string,
  inputs: Record<string, string>
): { text: string; count: number } {
  const paths = resolveTemplates(step.produces ?? [], inputs).map(p => (path.isAbsolute(p) ? p : path.join(workspaceRoot, p)));
  const parts: string[] = [];
  let total = 0;
  for (const filePath of paths) {
    if (total >= REVIEW_TOTAL_CHAR_CAP) break;
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
    const room = Math.min(REVIEW_ARTIFACT_CHAR_CAP, REVIEW_TOTAL_CHAR_CAP - total);
    const slice = content.slice(0, room);
    const truncated = slice.length < content.length ? '\n…[truncated]' : '';
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
 * Run the two-layer review and return a verdict. Layer 1 (validator) can short-circuit to
 * `rejected`; a missing *default* validator is treated as "skip layer 1" rather than a failure.
 * Layer 2 (LLM) runs only when `deep` and a kit + artifacts are present.
 */
export async function reviewStepArtifacts(opts: ReviewOptions): Promise<ReviewResult> {
  const { workspaceRoot, step, runState } = opts;

  // Layer 1 — deterministic validator.
  const explicitValidator = step.review.validatorPath;
  const verdict = await runValidator({ workspaceRoot, step, runState, stepOutput: '', validatorPath: explicitValidator || DEFAULT_REVIEW_VALIDATOR });
  const validatorMissing = !explicitValidator && verdict.decision === 'reject' && verdict.reason.startsWith('Failed to load');
  if (!validatorMissing && verdict.decision === 'reject') {
    return { status: 'rejected', note: `Validator: reject — ${verdict.reason}`, source: 'validator' };
  }

  // Layer 2 — optional deep LLM review.
  const reviewKit = opts.reviewKit ?? loadReviewKit(workspaceRoot);
  const artifacts = opts.artifacts ?? readProducedArtifacts(step, workspaceRoot, runState.inputs || {});
  if (!opts.deep || !reviewKit || artifacts.count === 0) {
    const reason = !opts.deep ? 'deep review disabled' : (!reviewKit ? 'review kit not installed' : 'no produced artifacts to read');
    return { status: 'approved', note: `Validator passed; LLM review skipped (${reason}).`, source: 'validator-only' };
  }

  const systemPrompt = `${reviewKit}\n\nRespond with ONLY a single-line JSON object: {"decision":"pass"|"reject","reason":"<short reason>"}.`;
  const userMessage = `Review the artifact(s) produced by step "${step.title || step.id}".\n\n${artifacts.text}`;
  const result = await opts.runner({
    systemPrompt,
    userMessage,
    model: opts.reviewModel || DEFAULT_REVIEW_MODEL,
    projectPath: workspaceRoot,
    onText: opts.onText ?? (() => {})
  });

  const parsed = parseVerdict(result.resultText);
  if (!parsed) return { status: 'waiting_human', note: 'could not parse an automated verdict; waiting for human review', source: 'llm' };
  if (parsed.decision === 'pass') return { status: 'approved', note: parsed.reason || 'approved', source: 'llm' };
  return { status: 'rejected', note: parsed.reason || 'rejected', source: 'llm' };
}
