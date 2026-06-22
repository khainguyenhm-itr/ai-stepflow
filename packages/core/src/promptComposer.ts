import { Agent, Skill } from './types.js';

/** Concatenate an agent system prompt with the bodies of the named skills. */
export function composeSystemPrompt(agent: Agent | undefined, skillNames: string[], skills: Skill[], produces?: string[], inputs: Record<string, string> = {}, requires?: string[]): string {
  const parts: string[] = [];
  if (agent?.systemPrompt?.trim()) parts.push(agent.systemPrompt.trim());

  if (Object.keys(inputs).length > 0) {
    parts.push(`## Run Metadata\nRelevant values for this run:\n${Object.entries(inputs).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`);
  }

  if (requires && requires.length > 0) {
    parts.push(`## Mandatory Input Files\nRead these upstream artifacts before starting — they are the inputs this task depends on:\n${requires.map(p => `- ${p}`).join('\n')}\n\nPaths are relative to the workspace root. If a listed file is missing, state that explicitly and proceed from the task description and Run Metadata.`);
  }

  for (const name of skillNames) {
    const skill = skills.find(item => item.name === name);
    if (skill?.instructions?.trim()) parts.push(`# Skill: ${skill.name}\n${skill.instructions.trim()}`);
  }

  if (produces && produces.length > 0) {
    parts.push(`## Mandatory Output Files\nFor this task, you MUST create or update the following files (these override any paths mentioned in the skill instructions above):\n${produces.map(p => `- ${p}`).join('\n')}\n\nPaths are relative to the workspace root. The system will verify these files exist before marking the task complete.`);
  }
  return parts.join('\n\n');
}
