import { Agent, Skill } from './types.js';

/** Concatenate an agent system prompt with the bodies of the named skills. */
export function composeSystemPrompt(agent: Agent | undefined, skillNames: string[], skills: Skill[]): string {
  const parts: string[] = [];
  if (agent?.systemPrompt?.trim()) parts.push(agent.systemPrompt.trim());
  for (const name of skillNames) {
    const skill = skills.find(item => item.name === name);
    if (skill?.instructions?.trim()) parts.push(`# Skill: ${skill.name}\n${skill.instructions.trim()}`);
  }
  return parts.join('\n\n');
}
