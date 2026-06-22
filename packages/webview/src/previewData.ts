import { Flow, Agent, Skill } from '@ai-stepflow/core/types';

/** Sample data used by the standalone browser preview (no VS Code host). */

export const previewFlow: Flow = {
  id: 'preview-docs-flow',
  name: 'Preview Documentation Flow',
  description: 'A local browser preview workflow used to inspect the UI without installing the VSIX.',
  inputs: {},
  sourcePath: '/preview/.claude/flows/preview-docs-flow.yaml',
  steps: [
    {
      id: 'collect-context',
      title: 'Collect Context',
      agent: 'aidlc-developer',
      skill: 'gitnexus-exploring',
      review: { required: false },
      completion: { requireMarkDone: true }
    },
    {
      id: 'write-docs',
      title: 'Write Docs',
      agent: 'aidlc-docs-writer',
      skill: 'create-plan',
      review: { required: true },
      completion: { requireMarkDone: true }
    }
  ]
};

export const previewAgents: Agent[] = [
  {
    name: 'aidlc-developer',
    description: 'Implements and checks code changes for AI StepFlow workflows.',
    model: 'sonnet',
    tools: ['files'],
    systemPrompt: 'You are a pragmatic implementation agent.',
    sourcePath: '/preview/.claude/agents/aidlc-developer.md',
    builtIn: true
  },
  {
    name: 'aidlc-docs-writer',
    description: 'Writes concise workflow documentation and review summaries.',
    model: 'sonnet',
    tools: ['files'],
    systemPrompt: 'You write clear internal documentation.',
    sourcePath: '/preview/.claude/agents/aidlc-docs-writer.md'
  }
];

export const previewSkills: Skill[] = [
  {
    name: 'create-plan',
    description: 'Creates a short implementation plan before making changes.',
    instructions: 'Break the task into clear implementation steps.',
    sourcePath: '/preview/.claude/skills/create-plan/SKILL.md'
  },
  {
    name: 'gitnexus-exploring',
    description: 'Explores code structure and execution flows.',
    instructions: 'Inspect relevant files and summarize the architecture.',
    sourcePath: '/preview/.claude/skills/gitnexus-exploring.md',
    builtIn: true
  }
];
