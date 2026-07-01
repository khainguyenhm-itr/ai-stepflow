import * as path from 'path';
import * as fs from 'fs';
import { FlowStep } from './types.js';
import { StepRunner } from './claudeRunner.js';
import { resolveTemplates, resolveFlowPath } from './pathTemplates.js';
import { missingMarkers, extractJsonObject } from './runUtils.js';

export interface ProducesValidationResult {
  ok: boolean;
  message?: string;
}

export interface RequiresValidationResult {
  ok: boolean;
  message?: string;
}

/** Verify a step's declared `requires` files exist before work continues. */
export function validateRequires(step: FlowStep, projectPath: string, inputs: Record<string, string> = {}, flowName = '', runSlug = ''): RequiresValidationResult {
  const requires = resolveTemplates(step.requires, inputs);
  if (requires.length === 0) return { ok: true };
  // Skip entries that are flow input keys (not file artifacts) — they are validated at flow start.
  const fileRequires = requires.filter(r => !(r in inputs));
  if (fileRequires.length === 0) return { ok: true };
  const resolved = fileRequires.map(p => resolveFlowPath(p, flowName, projectPath, runSlug));
  const missing = resolved.filter(p => !fs.existsSync(p));
  if (missing.length === 0) return { ok: true };
  return { ok: false, message: `missing required file(s): ${missing.map(p => path.relative(projectPath, p) || p).join(', ')}` };
}

/** Resolve a step's declared `produces` + review-file paths to absolute, de-duplicated paths. */
function resolveProducedPaths(step: FlowStep, projectPath: string, inputs: Record<string, string>, flowName: string, runSlug: string): string[] {
  const reviewPath = step.review.filePath ? [step.review.filePath] : [];
  const produces = resolveTemplates([...(step.produces ?? []), ...reviewPath], inputs);
  return [...new Set(produces.map(p => resolveFlowPath(p, flowName, projectPath, runSlug)))];
}

/** Verify a step's declared `produces`/review files exist on disk (existence only — no content check). */
export function validateProducesFiles(step: FlowStep, projectPath: string, inputs: Record<string, string> = {}, flowName = '', runSlug = ''): ProducesValidationResult {
  const resolved = resolveProducedPaths(step, projectPath, inputs, flowName, runSlug);
  if (resolved.length === 0) return { ok: true };
  const missing = resolved.filter(p => !fs.existsSync(p));
  if (missing.length) {
    return { ok: false, message: `missing file(s): ${missing.map(p => path.relative(projectPath, p) || p).join(', ')}` };
  }
  return { ok: true };
}

/** Read the produced files' combined contents (skipping unreadable ones). */
function readProducedContents(step: FlowStep, projectPath: string, inputs: Record<string, string>, flowName: string, runSlug: string): string {
  let contents = '';
  for (const p of resolveProducedPaths(step, projectPath, inputs, flowName, runSlug)) {
    try { contents += fs.readFileSync(p, 'utf8') + '\n'; } catch { /* read failure surfaces as a missing marker */ }
  }
  return contents;
}

/** Verify a step's declared `produces` files exist and contain any required markers (verbatim substring). */
export function validateProduces(step: FlowStep, projectPath: string, inputs: Record<string, string> = {}, flowName = '', runSlug = ''): ProducesValidationResult {
  const files = validateProducesFiles(step, projectPath, inputs, flowName, runSlug);
  if (!files.ok) return files;
  const markers = step.producesContains ?? [];
  if (markers.length === 0) return { ok: true };
  const missingContent = missingMarkers(readProducedContents(step, projectPath, inputs, flowName, runSlug), markers);
  if (missingContent.length) return { ok: false, message: `missing required content: ${missingContent.join(', ')}` };
  return { ok: true };
}

/** Combined produced-content payload fed to the semantic judge is capped so a large file can't blow up the prompt. */
const SEMANTIC_CONTENT_CHAR_CAP = 12000;

/**
 * Semantically verify a step's `producesContains` requirements against the produced file
 * contents using an injected LLM judge. Markers present verbatim are accepted with no LLM
 * call (free fast path); only the remainder are judged by meaning, so an agent need not echo
 * a requirement's exact wording. On a judge/parse failure the gate is lenient (`ok: true`):
 * the deterministic file-existence gate has already passed and the content markers are a soft
 * quality signal, so an LLM hiccup never traps the user on a step.
 */
export async function verifyProducesContent(
  step: FlowStep,
  projectPath: string,
  inputs: Record<string, string> = {},
  flowName = '',
  runner: StepRunner,
  model?: string,
  runSlug = ''
): Promise<ProducesValidationResult> {
  const markers = step.producesContains ?? [];
  if (markers.length === 0) return { ok: true };

  const contents = readProducedContents(step, projectPath, inputs, flowName, runSlug);
  const unverified = missingMarkers(contents, markers); // fast path: verbatim hits need no judging
  if (unverified.length === 0) return { ok: true };
  if (!contents.trim()) return { ok: false, message: `missing required content: ${unverified.join(', ')}` };

  const capped = contents.length > SEMANTIC_CONTENT_CHAR_CAP ? contents.slice(0, SEMANTIC_CONTENT_CHAR_CAP) : contents;
  const systemPrompt = 'You verify whether a document satisfies a list of content requirements. Judge by meaning, not exact wording. Respond with ONLY a single-line JSON object: {"unmet":["<verbatim requirement text>", ...]} — list each requirement the document does NOT satisfy; use an empty array if all are satisfied.';
  const userMessage = `Requirements:\n${unverified.map(m => `- ${m}`).join('\n')}\n\nDocument:\n${capped}`;
  try {
    const result = await runner({ systemPrompt, userMessage, model: model || 'haiku', projectPath, onText: () => {} });
    const json = extractJsonObject(result.resultText);
    if (!json) return { ok: true };
    const parsed = JSON.parse(json) as { unmet?: unknown };
    const unmet = Array.isArray(parsed.unmet) ? parsed.unmet.filter((x): x is string => typeof x === 'string') : [];
    if (unmet.length) return { ok: false, message: `missing required content: ${unmet.join(', ')}` };
    return { ok: true };
  } catch {
    return { ok: true };
  }
}
