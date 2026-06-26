import { Agent, Skill } from './types.js';

/**
 * The two-part prompt breakdown: a stable prefix (agent + skills) that can be served
 * from Anthropic's prompt-prefix cache, plus a small dynamic suffix that carries the
 * run-specific context (inputs, requires, produces).
 *
 * Why split? The Claude CLI / Anthropic API can cache the *prefix* of a system prompt
 * across calls made within the same TTL window (~5 min for Haiku/Sonnet). When several
 * steps in the same flow share the same agent and skills, the cache hit eliminates
 * redundant tokenisation and cuts cost by 60–90 % on the repeated portion.
 */
export interface ComposedSystemPromptParts {
  /** Agent system prompt + skills body. Stable across steps sharing the same agent/skills. */
  static: string;
  /** Run-specific context: inputs, requires gates, produces targets. Changes every run. */
  dynamic: string;
}

/**
 * Build the two-part system prompt breakdown for a step.
 *
 * @param agent      The resolved agent (undefined = no agent system prompt).
 * @param skillNames Ordered list of skill names the step will invoke.
 * @param skills     Full skill library to look up bodies from.
 * @param produces   Paths the step must create (run-input placeholders already resolved).
 * @param inputs     Run-level input values (feature name, etc.).
 * @param requires   Paths the step must read before starting.
 * @param producesContains Required content markers the produced file(s) must contain verbatim.
 */
export function composeSystemPromptParts(
  agent: Agent | undefined,
  skillNames: string[],
  skills: Skill[],
  produces?: string[],
  inputs: Record<string, string> = {},
  requires?: string[],
  producesContains?: string[]
): ComposedSystemPromptParts {
  // --- Static (cacheable) section: agent prompt + skills body ---
  const staticParts: string[] = [];
  if (agent?.systemPrompt?.trim()) staticParts.push(agent.systemPrompt.trim());

  for (const name of skillNames) {
    const skill = skills.find(item => item.name === name);
    if (skill?.instructions?.trim()) staticParts.push(`# Skill: ${skill.name}\n${skill.instructions.trim()}`);
  }

  // --- Dynamic (per-run) section: inputs + gate declarations ---
  const dynamicParts: string[] = [];

  if (Object.keys(inputs).length > 0) {
    dynamicParts.push(
      `## Run Metadata\nRelevant values for this run:\n` +
      Object.entries(inputs).map(([k, v]) => `- ${k}: ${v}`).join('\n')
    );
  }

  if (requires && requires.length > 0) {
    dynamicParts.push(
      `## Mandatory Input Files\nRead these upstream artifacts before starting — they are the inputs this task depends on:\n` +
      requires.map(p => `- ${p}`).join('\n') +
      `\n\nPaths are relative to the workspace root. If a listed file is missing, state that explicitly and proceed from the task description and Run Metadata.`
    );
  }

  if (produces && produces.length > 0) {
    dynamicParts.push(
      `## Mandatory Output Files\nFor this task, you MUST create or update the following files (these override any paths mentioned in the skill instructions above):\n` +
      produces.map(p => `- ${p}`).join('\n') +
      `\n\nPaths are relative to the workspace root. The system will verify these files exist before marking the task complete.`
    );
  }

  if (producesContains && producesContains.length > 0) {
    dynamicParts.push(
      `## Required Content\nThe output file(s) above MUST contain each of the following markers verbatim — include each one as a literal heading, label, or sentence so it appears word-for-word in the document:\n` +
      producesContains.map(m => `- ${m}`).join('\n') +
      `\n\nThe system checks for these exact strings before the task can be marked complete; if any is missing the step cannot proceed.`
    );
  }

  return {
    static: staticParts.join('\n\n'),
    dynamic: dynamicParts.join('\n\n'),
  };
}

/**
 * Convenience wrapper that joins static + dynamic into a single string.
 * Kept for backward-compatibility with callers that pass the combined prompt
 * directly to `--append-system-prompt`.
 */
export function composeSystemPrompt(
  agent: Agent | undefined,
  skillNames: string[],
  skills: Skill[],
  produces?: string[],
  inputs: Record<string, string> = {},
  requires?: string[],
  producesContains?: string[]
): string {
  const { static: s, dynamic: d } = composeSystemPromptParts(agent, skillNames, skills, produces, inputs, requires, producesContains);
  return [s, d].filter(Boolean).join('\n\n');
}
