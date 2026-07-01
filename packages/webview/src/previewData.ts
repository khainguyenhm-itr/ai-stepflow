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
      dependsOn: ['collect-context'],
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
    tags: ['dev'],
    builtIn: true
  },
  {
    name: 'aidlc-docs-writer',
    description: 'Writes concise workflow documentation and review summaries.',
    model: 'sonnet',
    tools: ['files'],
    systemPrompt: 'You write clear internal documentation.',
    sourcePath: '/preview/.claude/agents/aidlc-docs-writer.md',
    tags: ['docs']
  },
  {
    name: 'research-analyst',
    description: 'Gathers sources, synthesizes findings, and drafts research briefs.',
    model: 'opus',
    tools: ['web', 'files'],
    systemPrompt: 'You are a meticulous research analyst.',
    sourcePath: '/preview/.claude/agents/research-analyst.md',
    tags: ['research']
  },
  {
    name: 'research-reviewer',
    description: 'Fact-checks research output against cited sources.',
    model: 'sonnet',
    tools: ['web'],
    systemPrompt: 'You verify claims against evidence.',
    sourcePath: '/preview/.claude/agents/research-reviewer.md',
    tags: ['research', 'docs']
  },
  {
    name: 'sandbox-runner',
    description: 'Runs quick experiments in an isolated workspace.',
    model: 'haiku',
    tools: ['files'],
    systemPrompt: 'You run small, safe experiments.',
    sourcePath: '/preview/.claude/agents/sandbox-runner.md'
  }
];

export const previewSkills: Skill[] = [
  {
    name: 'create-plan',
    description: 'Creates a short implementation plan before making changes.',
    instructions: 'Break the task into clear implementation steps.',
    sourcePath: '/preview/.claude/skills/create-plan/SKILL.md',
    tags: ['dev']
  },
  {
    name: 'gitnexus-exploring',
    description: 'Explores code structure and execution flows.',
    instructions: 'Inspect relevant files and summarize the architecture.',
    sourcePath: '/preview/.claude/skills/gitnexus-exploring.md',
    tags: ['dev', 'research'],
    builtIn: true
  },
  {
    name: 'deep-research',
    description: 'Fan-out web search, verify claims, synthesize a cited report.',
    instructions: 'Search broadly, then verify and cite.',
    sourcePath: '/preview/.claude/skills/deep-research/SKILL.md',
    tags: ['research']
  },
  {
    name: 'consolidate-srs',
    description: 'Consolidate multiple SRS documents into a release document.',
    instructions: 'Collect and merge SRS items for a release.',
    sourcePath: '/preview/.claude/skills/consolidate-srs/SKILL.md',
    tags: ['docs']
  }
];
