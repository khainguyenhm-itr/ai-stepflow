/**
 * artifactLocator.ts — reconcile a declared produces/requires path with where the artifact
 * ACTUALLY landed on disk.
 *
 * A step declares a plain filename (e.g. `srs.md`), which resolves under the per-run output dir
 * `.claudesteps/output/{flow}/{run}/srs.md`. But an agent often nests its output one level deeper
 * (e.g. `.claudesteps/output/{flow}/{run}/artifact/srs.md`). The file is there, just at a different
 * depth than declared — which would break the produces gate, freshness check, and AI review.
 *
 * {@link locateProducedFile} closes that gap: it prefers the exact declared path, and only when
 * that is missing does it fall back to the newest same-named file found under the run's output
 * folder. Explicit paths (containing a separator) and absolute paths are treated literally — the
 * author placed them deliberately, so no fuzzy matching is applied.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveFlowPath, flowOutputDir } from './pathTemplates.js';

/** How deep to search under the run output dir for a nested artifact. Bounds a pathological tree. */
const MAX_LOCATE_DEPTH = 4;

function mtimeMs(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

/** Recursively collect files named `basename` under `dir` (depth-bounded), newest first. */
function findByBasename(dir: string, basename: string): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > MAX_LOCATE_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name === basename) out.push(full);
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => mtimeMs(b) - mtimeMs(a));
}

/**
 * Resolve a declared produces/requires path to where the artifact actually is.
 *
 * - Exact resolved path exists → return it.
 * - Plain filename, exact path missing → return the newest same-named file found anywhere under
 *   the run's output dir (handles an agent that nested the file in a subfolder).
 * - Explicit/absolute path, or no match found → return the exact resolved path unchanged, so the
 *   caller still sees a consistent "expected" location to report as missing.
 */
export function locateProducedFile(declaredPath: string, flowName: string, workspaceRoot: string, runSlug: string, legacyRunSlug = ''): string {
  const exact = resolveFlowPath(declaredPath, flowName, workspaceRoot, runSlug);
  if (fs.existsSync(exact)) return exact;
  // Only plain filenames live under the per-run output dir; explicit/absolute paths are literal.
  if (declaredPath.includes('/') || declaredPath.includes('\\') || path.isAbsolute(declaredPath)) return exact;
  const base = flowOutputDir(flowName, workspaceRoot, runSlug);
  const matches = findByBasename(base, path.basename(exact));
  if (matches[0]) return matches[0];
  // Backward compat: a run created before the runId fingerprint was added to the slug stored its
  // artifacts under the legacy (name-only) folder. Fall back to it so old runs still resolve.
  if (legacyRunSlug) {
    const legacyExact = resolveFlowPath(declaredPath, flowName, workspaceRoot, legacyRunSlug);
    if (fs.existsSync(legacyExact)) return legacyExact;
    const legacyMatches = findByBasename(flowOutputDir(flowName, workspaceRoot, legacyRunSlug), path.basename(exact));
    if (legacyMatches[0]) return legacyMatches[0];
  }
  return exact;
}
