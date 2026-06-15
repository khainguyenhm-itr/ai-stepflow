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

/** Sanitize a flow name into a safe folder name, capped at {@link FLOW_NAME_SLUG_MAX} chars. */
export function sanitizeFlowName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug.slice(0, FLOW_NAME_SLUG_MAX).replace(/-+$/, '') || 'unnamed');
}

/**
 * Resolve a produces/requires path entry to an absolute filesystem path.
 *
 * Convention:
 * - Plain filename (no path separator) → `.ai-stepflow/output/{flowName}/{filename}`
 * - Path with `/` or `\` → kept as-is (relative to workspaceRoot or absolute)
 */
export function resolveFlowPath(p: string, flowName: string, workspaceRoot: string): string {
  if (path.isAbsolute(p)) return p;
  if (p.includes('/') || p.includes('\\')) return path.join(workspaceRoot, p);
  return path.join(workspaceRoot, '.ai-stepflow', 'output', sanitizeFlowName(flowName), p);
}

/** The output folder for a flow's artifacts (absolute path). */
export function flowOutputDir(flowName: string, workspaceRoot: string): string {
  return path.join(workspaceRoot, '.ai-stepflow', 'output', sanitizeFlowName(flowName));
}

/**
 * Like resolveFlowPath but returns a workspace-relative path (not absolute).
 * Use this for agent prompts so paths are readable, not full-system paths.
 *
 * - Plain filename → `.ai-stepflow/output/{flowName}/{filename}` (relative)
 * - Path with `/` → kept as-is
 * - Absolute path → kept as-is
 */
export function resolveFlowRelativePath(p: string, flowName: string): string {
  if (path.isAbsolute(p)) return p;
  if (p.includes('/') || p.includes('\\')) return p;
  return `.ai-stepflow/output/${sanitizeFlowName(flowName)}/${p}`;
}
