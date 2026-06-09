import * as path from 'path';
import * as os from 'os';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { resolveTemplates } from './pathTemplates.js';
import { FlowRunState, FlowStep } from './types.js';

export interface ValidatorContext {
  workspaceRoot: string;
  step: FlowStep;
  runState: FlowRunState;
  stepOutput: string;
  paths: {
    requires: string[];
    produces: string[];
  };
}

export interface ValidatorVerdict {
  decision: 'pass' | 'reject';
  reason: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Resolve a validator path: absolute as-is; otherwise prefer a project-local file, then fall
 * back to the global `~/.claude/validators` library (where bundled defaults are installed).
 */
function resolveValidatorModule(validatorPath: string, workspaceRoot: string): string {
  if (path.isAbsolute(validatorPath)) return validatorPath;
  const local = path.join(workspaceRoot, validatorPath);
  if (existsSync(local)) return local;
  const global = path.join(os.homedir(), '.claude', 'validators', validatorPath);
  if (existsSync(global)) return global;
  return local; // fall through so the import yields a clear "failed to load" message
}

/** Load and execute a deterministic validator module for auto-review. */
export async function runValidator(args: {
  workspaceRoot: string;
  step: FlowStep;
  runState: FlowRunState;
  stepOutput: string;
  /** Overrides `step.review.validatorPath` — used to apply a bundled default validator. */
  validatorPath?: string;
}): Promise<ValidatorVerdict> {
  const { workspaceRoot, step, runState, stepOutput } = args;
  const validatorPath = args.validatorPath ?? step.review.validatorPath;
  if (!validatorPath) {
    return { decision: 'reject', reason: 'No validatorPath configured.' };
  }

  const modulePath = resolveValidatorModule(validatorPath, workspaceRoot);
  const url = pathToFileURL(modulePath).href;
  let mod: unknown;
  try {
    mod = await import(url);
  } catch (error) {
    return { decision: 'reject', reason: `Failed to load validator '${validatorPath}': ${error instanceof Error ? error.message : String(error)}` };
  }

  const fn = (mod as { default?: unknown }).default;
  if (typeof fn !== 'function') {
    return { decision: 'reject', reason: `Validator '${validatorPath}' must default-export a function.` };
  }

  const ctx: ValidatorContext = {
    workspaceRoot,
    step,
    runState,
    stepOutput,
    paths: {
      requires: resolveTemplates(step.requires, runState.inputs).map(filePath => path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath)),
      produces: resolveTemplates(step.produces, runState.inputs).map(filePath => path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath))
    }
  };

  const timeoutMs = step.review.validatorTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const TIMEOUT = Symbol('timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve((fn as (ctx: ValidatorContext) => unknown)(ctx)),
      new Promise<typeof TIMEOUT>(resolve => { timer = setTimeout(() => resolve(TIMEOUT), timeoutMs); })
    ]);
    if (result === TIMEOUT) {
      return { decision: 'reject', reason: `Validator timed out after ${timeoutMs}ms.` };
    }
    if (!result || typeof result !== 'object') {
      return { decision: 'reject', reason: `Validator returned malformed verdict: ${JSON.stringify(result)}` };
    }
    const decision = (result as { decision?: unknown }).decision;
    const reason = (result as { reason?: unknown }).reason;
    if ((decision === 'pass' || decision === 'reject') && typeof reason === 'string') {
      return { decision, reason };
    }
    return { decision: 'reject', reason: `Validator returned malformed verdict: ${JSON.stringify(result)}` };
  } catch (error) {
    return { decision: 'reject', reason: `Validator threw: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
