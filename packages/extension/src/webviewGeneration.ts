import { Flow, FlowStep } from '@claudesteps/core';

/**
 * Coerce an untrusted `inputs` object (from an AI-generated flow draft) into a clean
 * `Flow['inputs']` record: drop blank names, default type to 'string', required to true, label to ''.
 * Pure — no host/fs access — so it is unit-tested in isolation.
 */
export function normalizeFlowInputs(inputs: unknown): Flow['inputs'] {
  if (!inputs || typeof inputs !== 'object') return {};
  const normalized: Flow['inputs'] = {};
  for (const [name, raw] of Object.entries(inputs as Record<string, unknown>)) {
    if (!name.trim()) continue;
    const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    normalized[name.trim()] = {
      type: typeof input.type === 'string' ? input.type : 'string',
      required: typeof input.required === 'boolean' ? input.required : true,
      label: typeof input.label === 'string' ? input.label : ''
    };
  }
  return normalized;
}

/**
 * Coerce an untrusted list of AI-generated steps into valid {@link FlowStep}s: slugify + de-dupe ids,
 * keep only agents/skills that actually exist (via the provided name sets), default dependsOn to the
 * previous step, and normalize the review gate. Pure — unit-tested in isolation.
 */
export function normalizeGeneratedSteps(steps: unknown[], agentNames: Set<string>, skillNames: Set<string>): FlowStep[] {
  const usedIds = new Set<string>();
  const normalizedIds: string[] = [];
  return steps.map((raw, index) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const fallbackId = `step-${index + 1}`;
    let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : fallbackId;
    id = id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || fallbackId;
    while (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);
    normalizedIds.push(id);

    const rawSkills = Array.isArray(item.skills) ? item.skills : (typeof item.skill === 'string' ? [item.skill] : []);
    const skills = rawSkills.filter((name): name is string => typeof name === 'string' && skillNames.has(name));
    const agent = typeof item.agent === 'string' && agentNames.has(item.agent) ? item.agent : '';
    const review = item.review && typeof item.review === 'object' ? item.review as Record<string, unknown> : {};
    return {
      id,
      title: typeof item.title === 'string' ? item.title : id,
      agent,
      skill: skills[0] || '',
      skills,
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.filter((value): value is string => typeof value === 'string') : (index > 0 ? [normalizedIds[index - 1]] : []),
      requires: Array.isArray(item.requires) ? item.requires.filter((value): value is string => typeof value === 'string') : undefined,
      produces: Array.isArray(item.produces) ? item.produces.filter((value): value is string => typeof value === 'string') : undefined,
      producesContains: Array.isArray(item.producesContains) ? item.producesContains.filter((value): value is string => typeof value === 'string') : undefined,
      review: { required: true, type: review.type === 'human' ? 'human' : 'ai' }
    };
  });
}
