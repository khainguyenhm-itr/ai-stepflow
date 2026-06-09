import { z } from 'zod';
import { Flow, FlowStep } from './types.js';

/**
 * Zod schemas for the untrusted YAML in flow files. They stay lenient about
 * hand-written omissions (defaulting optional fields the way the old normalizer did)
 * but reject genuinely malformed structure (e.g. `steps` that is not a list) with a
 * readable error instead of silently producing a broken flow.
 */

const stringArray = z.array(z.coerce.string()).optional();

const reviewerSchema = z.object({
  type: z.enum(['human', 'ai']),
  agent: z.string().optional(),
  skill: z.string().optional()
});

const reviewSchema = z
  .object({
    required: z.boolean().default(false),
    // An unknown review type degrades to "unset" rather than failing the whole flow.
    type: z.enum(['human', 'ai']).optional().catch(undefined),
    validatorPath: z.string().optional(),
    deep: z.boolean().optional(),
    validatorTimeoutMs: z.number().int().positive().optional(),
    filePath: z.string().optional(),
    reviewers: z.array(reviewerSchema).optional(),
    approvalRequired: z.boolean().optional(),
    checklist: z.array(z.coerce.string()).optional()
  })
  .default({});

const stepSchema = z.preprocess(
  raw => {
    const step = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
    // Accept snake_case `produces_contains` as an alias for `producesContains`.
    if (step.producesContains === undefined && step.produces_contains !== undefined) {
      step.producesContains = step.produces_contains;
    }
    return step;
  },
  z.object({
    id: z.coerce.string().default(''),
    title: z.coerce.string().default(''),
    agent: z.coerce.string().default(''),
    skill: z.coerce.string().default(''),
    skills: stringArray,
    dependsOn: stringArray,
    requires: stringArray,
    produces: stringArray,
    producesContains: stringArray,
    input: z.object({ humanRequired: z.boolean().optional(), prompt: z.coerce.string().optional() }).optional(),
    review: reviewSchema,
    completion: z.object({ requireMarkDone: z.boolean().default(false) }).default({ requireMarkDone: false })
  })
);

const inputSchema = z.object({
  type: z.coerce.string().default('string'),
  required: z.boolean().default(false),
  label: z.coerce.string().default('')
});

const flowSchema = z.object({
  id: z.coerce.string().optional(),
  name: z.coerce.string().optional(),
  description: z.coerce.string().optional(),
  inputs: z.record(z.string(), inputSchema).default({}),
  steps: z.array(stepSchema).default([])
});

/** Validate parsed YAML and produce a {@link Flow}. Throws {@link z.ZodError} on hard failures. */
export function parseFlow(data: unknown, fallbackId: string, sourcePath: string): Flow {
  const parsed = flowSchema.parse(data);
  return {
    id: parsed.id || fallbackId,
    name: parsed.name || parsed.id || fallbackId,
    description: parsed.description || '',
    inputs: parsed.inputs as Flow['inputs'],
    steps: parsed.steps as FlowStep[],
    sourcePath
  };
}

/**
 * Permissive shape guards for payloads the webview posts to the host. Unlike {@link parseFlow}
 * (which normalizes), these only *validate* deeply and never mutate or strip fields: they use
 * `.passthrough()` so unknown keys survive and the handler still receives the original object.
 * They go one level deeper than a bare `typeof === 'object'` check — asserting `steps` are
 * objects with an `id`, and a run state's `steps` map carries the three status strings — so a
 * malformed message can't reach a file write or a state transition.
 */
const flowShapeSchema = z.object({
  id: z.string(),
  sourcePath: z.string(),
  steps: z.array(z.object({ id: z.string() }).passthrough())
}).passthrough();

const stepRunStateShapeSchema = z.object({
  executionStatus: z.string(),
  reviewStatus: z.string(),
  completionStatus: z.string()
}).passthrough();

const flowRunStateShapeSchema = z.object({
  flowId: z.string(),
  runId: z.string(),
  steps: z.record(z.string(), stepRunStateShapeSchema)
}).passthrough();

/** True when `value` is a structurally valid {@link Flow} the host can safely persist/run. */
export function isFlowShape(value: unknown): boolean {
  return flowShapeSchema.safeParse(value).success;
}

/** True when `value` is a structurally valid {@link FlowRunState} the host can safely persist/drive. */
export function isFlowRunStateShape(value: unknown): boolean {
  return flowRunStateShapeSchema.safeParse(value).success;
}

/** A one-line, human-readable rendering of a validation failure for logs/messages. */
export function formatFlowError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}
