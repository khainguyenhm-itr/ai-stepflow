import * as path from 'path';
import { pathToFileURL } from 'url';
import { ClaudeStreamingRunOptions, ClaudeStreamingRunResult, StepRunner, defaultStepRunner } from './claudeRunner.js';

/**
 * Load a custom step runner module (mirrors {@link runValidator}'s dynamic-import contract).
 * Throws a descriptive error if the path can't be imported or doesn't default-export a function.
 * The returned runner normalizes the module's result so callers always get a well-formed
 * {@link ClaudeStreamingRunResult}.
 */
export async function loadStepRunner(runnerPath: string, workspaceRoot: string): Promise<StepRunner> {
  const modulePath = path.isAbsolute(runnerPath) ? runnerPath : path.join(workspaceRoot, runnerPath);
  const url = pathToFileURL(modulePath).href;
  let mod: unknown;
  try {
    mod = await import(url);
  } catch (error) {
    throw new Error(`Failed to load runner '${runnerPath}': ${error instanceof Error ? error.message : String(error)}`);
  }

  const fn = (mod as { default?: unknown }).default;
  if (typeof fn !== 'function') {
    throw new Error(`Runner '${runnerPath}' must default-export a function.`);
  }
  const runner = fn as StepRunner;

  return async (opts: ClaudeStreamingRunOptions): Promise<ClaudeStreamingRunResult> => {
    const result = await runner(opts);
    if (!result || typeof result !== 'object' || typeof (result as ClaudeStreamingRunResult).success !== 'boolean') {
      throw new Error(`Runner '${runnerPath}' returned a malformed result; expected an object with a boolean 'success'.`);
    }
    const r = result as ClaudeStreamingRunResult;
    return {
      ...r,
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : (r.success ? 0 : 1),
      resultText: typeof r.resultText === 'string' ? r.resultText : ''
    };
  };
}

/** Pick a step's runner: the agent's custom module when `runnerPath` is set, else the built-in runner. */
export async function resolveStepRunner(runnerPath: string | undefined, workspaceRoot: string): Promise<StepRunner> {
  return runnerPath ? loadStepRunner(runnerPath, workspaceRoot) : defaultStepRunner;
}
