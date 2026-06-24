/**
 * runConfig.ts — pure helpers for resolving per-run configuration and composing
 * run inputs. Extracted from the VS Code extension's RunOrchestrator/stepRunner so the
 * branching logic can be unit-tested under `node --test` without a VS Code host.
 * Nothing here reads `vscode`, the filesystem, or any ambient state.
 */

/**
 * Pick the agentic turn cap for a run: an agent-level override wins when it is set to a
 * non-negative number (0 = "no limit"); otherwise fall back to the global default.
 */
export function resolveMaxTurns(agentMaxTurns: number | undefined, globalDefault: number): number {
  if (agentMaxTurns != null && agentMaxTurns >= 0) return agentMaxTurns;
  return globalDefault;
}

/** Convert a configured timeout in seconds to milliseconds; `<= 0` means no limit (0). */
export function resolveTimeoutMs(timeoutSeconds: number): number {
  return timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0;
}

/**
 * Build the headless MCP config string (`{"mcpServers":{...}}`) from an allowlist of server
 * names resolved against the user's ambient MCP definitions. An empty/undefined allowlist
 * yields no servers, so headless runs carry minimal tool context. Names with no ambient
 * definition are silently skipped.
 */
export function buildHeadlessMcpConfig(allow: string[] | undefined, ambient: Record<string, unknown>): string {
  if (!allow || allow.length === 0) return '{"mcpServers":{}}';
  const servers: Record<string, unknown> = {};
  for (const name of allow) {
    if (ambient[name] !== undefined) servers[name] = ambient[name];
  }
  return JSON.stringify({ mcpServers: servers });
}

/**
 * Compose the pre-filled message for an interactive (terminal) step: the primary skill as a
 * `/skill` slash command (or the bare description when there is no skill), followed by the
 * mandatory input/output file lists. `description`, `requires`, and `produces` are expected to
 * already have their run-input placeholders resolved.
 */
export function composeInteractiveMessage(
  primarySkill: string | undefined,
  description: string,
  requires: string[],
  produces: string[]
): string {
  let message = primarySkill ? `/${primarySkill} ${description}` : description;
  if (requires.length > 0) {
    message += `\n\nMandatory input files (relative to workspace root, read these first):\n${requires.map(p => `- ${p}`).join('\n')}`;
  }
  if (produces.length > 0) {
    message += `\n\nMandatory output files (relative to workspace root, you MUST create these):\n${produces.map(p => `- ${p}`).join('\n')}`;
  }
  return message;
}
