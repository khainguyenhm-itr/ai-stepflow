/**
 * Pure run-orchestration helpers, deliberately free of any `vscode` import so they
 * can be unit-tested in plain Node and later reused outside the extension host.
 */

import type { StepRunState } from './types.js';

export interface ReadyStepInput {
  id: string;
  dependsOn?: string[];
}

/**
 * Pick the steps that should auto-run next: those whose dependencies are all done,
 * that have not finished or started yet, and that actually declare dependencies
 * (root steps stay user-triggered so a run never starts itself).
 */
export function computeReadySteps(
  steps: ReadyStepInput[],
  done: ReadonlySet<string>,
  started: ReadonlySet<string>
): string[] {
  const ready: string[] = [];
  for (const step of steps) {
    if (done.has(step.id) || started.has(step.id)) continue;
    const deps = step.dependsOn ?? [];
    if (deps.length === 0) continue;
    if (deps.every(d => done.has(d))) ready.push(step.id);
  }
  return ready;
}

/**
 * The auto-advance decision: return the single dependent step to launch next, or
 * `undefined` when zero or several are ready. Interactive runs open a terminal and
 * wait for the user, so the orchestrator only auto-prefills when the path is
 * unambiguous; when several unlock at once it leaves them for the user to launch so
 * prefills don't pile into one chat box.
 */
export function pickAutoAdvanceStep(
  steps: ReadyStepInput[],
  done: ReadonlySet<string>,
  started: ReadonlySet<string>
): string | undefined {
  const ready = computeReadySteps(steps, done, started);
  return ready.length === 1 ? ready[0] : undefined;
}

/**
 * Fan-out auto-advance: return EVERY dependent step whose dependencies are all done and that
 * hasn't started yet, in input order. The orchestrator launches the headless/AI ones
 * concurrently and opens at most one interactive step, so a diamond no longer stalls when
 * several branches unlock at once.
 */
export function pickAutoAdvanceSteps(
  steps: ReadyStepInput[],
  done: ReadonlySet<string>,
  started: ReadonlySet<string>
): string[] {
  return computeReadySteps(steps, done, started);
}

/**
 * Seed the "already started" set when adopting a restored run, so it never auto-re-runs
 * a step that already ran (e.g. one parked at a review gate). A step is treated as
 * started once it has moved past its pristine ready/locked + not_ready state.
 */
export function seedStartedSteps(steps: Record<string, StepRunState>): Set<string> {
  const started = new Set<string>();
  for (const [id, s] of Object.entries(steps)) {
    const pristine = (s.executionStatus === 'ready' || s.executionStatus === 'locked') && s.completionStatus === 'not_ready';
    if (!pristine) started.add(id);
  }
  return started;
}

/** Pull a {decision, reason} verdict out of an automated reviewer's reply. */
export function parseVerdict(text: string): { decision: 'pass' | 'reject'; reason?: string } | undefined {
  if (!text) return undefined;
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return undefined;
  try {
    const obj = JSON.parse(match[0]);
    const decision = String(obj.decision ?? '').toLowerCase();
    const reason = typeof obj.reason === 'string' ? obj.reason : undefined;
    if (decision === 'pass' || decision === 'approved') return { decision: 'pass', reason };
    if (decision === 'reject' || decision === 'rejected') return { decision: 'reject', reason };
  } catch { /* not JSON */ }
  return undefined;
}

/** Total token count from a claude stream-json `usage` object, or undefined if absent. */
export function summarizeUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  return num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
}

/** Substrings from `markers` not present anywhere in `contents`. */
export function missingMarkers(contents: string, markers: string[]): string[] {
  return markers.filter(m => !contents.includes(m));
}

/**
 * Extract the first complete JSON object from model output. The scanner tracks JSON
 * strings and escapes, so braces and Markdown code fences inside string values do
 * not truncate the object.
 */
export function extractJsonObject(text: string): string {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, index + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error('no JSON object found');
}
