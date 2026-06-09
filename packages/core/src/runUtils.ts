/**
 * Pure run-orchestration helpers, deliberately free of any `vscode` import so they
 * can be unit-tested in plain Node and later reused outside the extension host.
 */

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
