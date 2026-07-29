import { FlowRunState } from '@claudesteps/core/types';
import { ScopeFilter, ViewFilter, ViewFilterItem, SortOrder } from './types.js';

const VALID_FILTERS: ScopeFilter[] = ['all', 'project', 'global'];

/** Validate a persisted scope filter against the allowed set; anything else falls back to 'all'. */
export const parseScopeFilter = (v: string | undefined): ScopeFilter =>
  VALID_FILTERS.includes(v as ScopeFilter) ? (v as ScopeFilter) : 'all';

/** Keep only 'built-in'; migrate the old persisted string form to a single-item array. */
export const parseViewFilter = (v: unknown): ViewFilter => {
  if (Array.isArray(v)) return (v as string[]).filter((x): x is ViewFilterItem => x === 'built-in');
  if (v === 'built-in') return [v]; // migrate old persisted string
  return [];
};

/** Pass known sort orders through; anything else means the default 'activity' order. */
export const parseSortOrder = (v: string | undefined): SortOrder =>
  v === 'desc' || v === 'asc' || v === 'newest' || v === 'oldest' ? v : 'activity';

/** Group-by is 'tag' only for the literal 'tag'; everything else is a flat list. */
export const parseGroupBy = (v: string | undefined): 'list' | 'tag' => (v === 'tag' ? 'tag' : 'list');

/** Return a new map without `key`; never mutates the input (absent key → plain copy). */
export const dropKey = <T>(map: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _drop, ...rest } = map;
  return rest;
};

/** Append a stream chunk to prior output, or replace it when the message is not an append. */
export const appendOutput = (prev: string | undefined, chunk: string | undefined, append: boolean): string =>
  append ? `${prev || ''}${chunk || ''}` : (chunk || '');

export type RunAggregate = {
  completedSteps: number;
  inProgressSteps: number;
  reviewing: boolean;
  failedSteps: number;
  totalSteps: number;
  costUsd: number;
  tokensUsed: number;
  taskTimeMs: number;
  reviewTimeMs: number;
};

/**
 * Roll a run's steps up into the fields the runs table shows. Pure over `changed` — used to keep the
 * outer table row in sync with a live run without a full reload. `inProgressSteps` counts steps that
 * have started but aren't done (running or under review) so a step in flight shows its position.
 */
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
