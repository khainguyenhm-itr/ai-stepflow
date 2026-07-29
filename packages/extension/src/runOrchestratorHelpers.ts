/**
 * Pure helpers for per-run key isolation. Concurrent runs share process-global maps/sets keyed by
 * step; without namespacing, two runs that reuse a stepId (e.g. "step-1") would clobber each other.
 * These functions are the single source of truth for that namespacing and are unit-tested in
 * isolation, so the isolation guarantee does not depend on the orchestrator's internals.
 */

/** Composite key so process-global collections never confuse two runs that share a stepId. */
export const runKey = (runId: string, stepId: string): string => `${runId}::${stepId}`;

/**
 * True iff `key` belongs to `runId`. The trailing `::` in the prefix prevents a false match where
 * one runId is a textual prefix of another (e.g. runId "a1" must not match key "a10::step").
 */
export const isRunKeyOf = (key: string, runId: string): boolean => key.startsWith(`${runId}::`);
