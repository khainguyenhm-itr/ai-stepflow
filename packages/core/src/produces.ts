import * as path from 'path';
import * as fs from 'fs';
import { FlowStep } from './types.js';
import { resolveTemplates } from './pathTemplates.js';
import { missingMarkers } from './runUtils.js';

export interface ProducesValidationResult {
  ok: boolean;
  message?: string;
}

export interface RequiresValidationResult {
  ok: boolean;
  message?: string;
}

/** Verify a step's declared `requires` files exist before work continues. */
export function validateRequires(step: FlowStep, projectPath: string, inputs: Record<string, string> = {}): RequiresValidationResult {
  const requires = resolveTemplates(step.requires, inputs);
  if (requires.length === 0) return { ok: true };
  // Skip entries that are flow input keys (not file artifacts) — they are validated at flow start.
  const fileRequires = requires.filter(r => !(r in inputs));
  if (fileRequires.length === 0) return { ok: true };
  const resolved = fileRequires.map(p => (path.isAbsolute(p) ? p : path.join(projectPath, p)));
  const missing = resolved.filter(p => !fs.existsSync(p));
  if (missing.length === 0) return { ok: true };
  return { ok: false, message: `missing required file(s): ${missing.map(p => path.relative(projectPath, p) || p).join(', ')}` };
}

/** Verify a step's declared `produces` files exist and contain any required markers. */
export function validateProduces(step: FlowStep, projectPath: string, inputs: Record<string, string> = {}): ProducesValidationResult {
  const reviewPath = step.review.filePath ? [step.review.filePath] : [];
  const produces = resolveTemplates([...(step.produces ?? []), ...reviewPath], inputs);
  if (produces.length === 0) return { ok: true };
  const resolved = [...new Set(produces.map(p => (path.isAbsolute(p) ? p : path.join(projectPath, p))))];

  const missing = resolved.filter(p => !fs.existsSync(p));
  if (missing.length) {
    return { ok: false, message: `missing file(s): ${missing.map(p => path.relative(projectPath, p) || p).join(', ')}` };
  }

  const markers = step.producesContains ?? [];
  if (markers.length === 0) return { ok: true };
  let contents = '';
  for (const p of resolved) {
    try { contents += fs.readFileSync(p, 'utf8'); } catch { /* read failure surfaces as a missing marker */ }
  }
  const missingContent = missingMarkers(contents, markers);
  if (missingContent.length) return { ok: false, message: `missing required content: ${missingContent.join(', ')}` };
  return { ok: true };
}
