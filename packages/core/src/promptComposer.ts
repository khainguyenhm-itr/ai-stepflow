import { Agent, Skill } from './types.js';

/** Concatenate an agent system prompt with the bodies of the named skills. */
export function composeSystemPrompt(agent: Agent | undefined, skillNames: string[], skills: Skill[], produces?: string[], inputs: Record<string, string> = {}): string {
  const parts: string[] = [];
  if (agent?.systemPrompt?.trim()) parts.push(agent.systemPrompt.trim());

  if (Object.keys(inputs).length > 0) {
    parts.push(`## Run Metadata\nRelevant values for this run:\n${Object.entries(inputs).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`);
  }

  if (produces && produces.length > 0) {
    parts.push(`## Mandatory Output Files\nFor this task, you MUST create or update the following files:\n${produces.map(p => `- ${p}`).join('\n')}\n\nThe system will verify the existence of these files before allowing the task to be marked as complete.`);
  }

  for (const name of skillNames) {
    const skill = skills.find(item => item.name === name);
    if (skill?.instructions?.trim()) parts.push(`# Skill: ${skill.name}\n${skill.instructions.trim()}`);
  }
  return parts.join('\n\n');
}
