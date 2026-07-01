import * as path from 'path';

/** Resolve `{name}` placeholders from run inputs; unknown keys are left as-is. */
export function resolveTemplate(value: string, inputs: Record<string, string> = {}): string {
  return value.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    const resolved = inputs[key];
    return resolved == null || resolved === '' ? `{${key}}` : resolved;
  });
}

export function resolveTemplates(values: string[] | undefined, inputs: Record<string, string> = {}): string[] {
  return (values ?? []).map(value => resolveTemplate(value, inputs));
}

/** Maximum character length for a sanitized flow name slug. */
export const FLOW_NAME_SLUG_MAX = 50;

/** Slugify a name into a safe folder segment ('' when it reduces to nothing). */
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, FLOW_NAME_SLUG_MAX).replace(/-+$/, '');
}

/** Sanitize a flow name into a safe folder name, capped at {@link FLOW_NAME_SLUG_MAX} chars. */
export function sanitizeFlowName(name: string): string {
  return slugify(name) || 'unnamed';
}

/**
 * Per-run output subfolder slug: from the run name, else the run id, else `run`.
 * Lets multiple runs of the same flow keep separate artifact folders.
 */
export function runOutputSlug(runName?: string, runId?: string): string {
  return slugify(runName || '') || slugify(runId || '') || 'run';
}

/** Join the flow (+ optional run) output folder onto a plain filename. */
function outputBase(workspaceRoot: string, flowName: string, runSlug: string): string {
  const base = path.join(workspaceRoot, '.ai-stepflow', 'output', sanitizeFlowName(flowName));
  return runSlug ? path.join(base, runSlug) : base;
}

/**
 * Resolve a produces/requires path entry to an absolute filesystem path.
 *
 * Convention:
 * - Plain filename (no path separator) → `.ai-stepflow/output/{flowName}/{runSlug}/{filename}`
 * - Path with `/` or `\` → kept as-is (relative to workspaceRoot or absolute)
 *
 * `runSlug` scopes artifacts per run; omit it (legacy callers) for flow-level output.
 */
export function resolveFlowPath(p: string, flowName: string, workspaceRoot: string, runSlug = ''): string {
  if (path.isAbsolute(p)) return p;
  if (p.includes('/') || p.includes('\\')) return path.join(workspaceRoot, p);
  return path.join(outputBase(workspaceRoot, flowName, runSlug), p);
}

/** The output folder for a flow's (optionally a run's) artifacts (absolute path). */
export function flowOutputDir(flowName: string, workspaceRoot: string, runSlug = ''): string {
  return outputBase(workspaceRoot, flowName, runSlug);
}

/**
 * Like resolveFlowPath but returns a workspace-relative path (not absolute).
 * Use this for agent prompts so paths are readable, not full-system paths.
 *
 * - Plain filename → `.ai-stepflow/output/{flowName}/{runSlug}/{filename}` (relative)
 * - Path with `/` → kept as-is
 * - Absolute path → kept as-is
 */
export function resolveFlowRelativePath(p: string, flowName: string, runSlug = ''): string {
  if (path.isAbsolute(p)) return p;
  if (p.includes('/') || p.includes('\\')) return p;
  const folder = runSlug ? `${sanitizeFlowName(flowName)}/${runSlug}` : sanitizeFlowName(flowName);
  return `.ai-stepflow/output/${folder}/${p}`;
}
