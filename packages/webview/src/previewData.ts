import { Flow, Agent, Skill, FlowRunState } from '@claudesteps/core/types';

/** Sample data used by the standalone browser preview (no VS Code host). */

export const previewFlow: Flow = {
  id: 'preview-docs-flow',
  name: 'Preview Documentation Flow',
  description: 'A local browser preview workflow used to inspect the UI without installing the VSIX.',
  inputs: {
    topic: { type: 'string', required: true, label: 'Documentation topic' }
  },
  sourcePath: '/preview/.claude/flows/preview-docs-flow.yaml',
  steps: [
    {
      id: 'collect-context',
      title: 'Collect Context',
      agent: 'aidlc-developer',
      skill: 'gitnexus-exploring',
      requires: ['docs/sources/architecture.md', 'docs/sources/api-notes.md'],
      produces: ['docs/generated/context.md'],
      review: { required: true, type: 'ai' }
    },
    {
      id: 'write-docs',
      title: 'Write Docs',
      agent: 'aidlc-docs-writer',
      skill: 'create-plan',
      dependsOn: ['collect-context'],
      requires: ['docs/generated/context.md'],
      produces: ['docs/generated/guide.md', 'docs/generated/changelog.md'],
      review: { required: true, type: 'human' }
    },
    {
      id: 'review-draft',
      title: 'Review Draft',
      agent: 'research-reviewer',
      skill: 'gitnexus-exploring',
      dependsOn: ['write-docs'],
      requires: ['docs/generated/guide.md'],
      produces: ['docs/generated/review-notes.md'],
      review: { required: true, type: 'ai' }
    },
    {
      id: 'publish-docs',
      title: 'Publish Docs',
      agent: 'aidlc-docs-writer',
      skill: 'consolidate-srs',
      dependsOn: ['review-draft'],
      requires: ['docs/generated/guide.md'],
      produces: ['docs/release/RELEASE-NOTES.md'],
      review: { required: true, type: 'ai' }
    },
    {
      id: 'announce',
      title: 'Announce',
      agent: 'aidlc-docs-writer',
      skill: 'create-plan',
      dependsOn: ['publish-docs'],
      requires: ['docs/release/RELEASE-NOTES.md'],
      produces: ['docs/release/ANNOUNCEMENT.md'],
      review: { required: true, type: 'human' }
    }
  ]
};

/**
 * A mid-flight sample run for the standalone preview so the runner sub-tabs (Console / Files /
 * Cost / History) show real content. Step 1 is approved (AI review → has a report file), step 2
 * is currently under HUMAN review (no report file — demonstrates the review-file rule), and the
 * rest are still locked. This makes the runs table show "2/5" with the yellow "Reviewing" state.
 */
export const previewRunState: FlowRunState = {
  flowId: previewFlow.id,
  runId: '2026-07-15T02:30:00.000Z',
  runName: 'Preview run · docs',
  flowName: previewFlow.name,
  source: previewFlow.sourcePath,
  projectPath: '/preview/project',
  inputs: { topic: 'ClaudeSteps overview' },
  autoReview: false,
  steps: {
    'collect-context': {
      executionStatus: 'completed',
      reviewStatus: 'approved',
      completionStatus: 'done',
      output: 'Collected architecture notes and API surface.\nWrote docs/generated/context.md (42 sections).\n\n[review (llm): approved — context is complete and consistent]\n[AI review report written → .claudesteps/reports/reviews/preview-docs-flow-collect-context.md]',
      reviewReportPath: '.claudesteps/reports/reviews/preview-docs-flow-collect-context.md',
      startedAt: '2026-07-15T02:30:05.000Z',
      completedAt: '2026-07-15T02:31:12.000Z',
      reviewCompletedAt: '2026-07-15T02:31:40.000Z',
      tokensUsed: 18450,
      costUsd: 0.2137,
      modelUsed: 'claude-sonnet-5',
      history: [
        { timestamp: '2026-07-15T02:30:05.000Z', status: 'running', message: 'Run started' },
        { timestamp: '2026-07-15T02:31:12.000Z', status: 'completed', message: 'Step completed' },
        { timestamp: '2026-07-15T02:31:40.000Z', status: 'approved', message: 'Review (llm): approved' }
      ]
    },
    'write-docs': {
      executionStatus: 'completed',
      reviewStatus: 'waiting_human',
      completionStatus: 'not_ready',
      output: 'Drafted docs/generated/guide.md and docs/generated/changelog.md.\n\n[waiting for human review — approve or reject to continue]',
      startedAt: '2026-07-15T02:31:45.000Z',
      completedAt: '2026-07-15T02:33:02.000Z',
      tokensUsed: 26110,
      costUsd: 0.3042,
      modelUsed: 'claude-sonnet-5',
      history: [
        { timestamp: '2026-07-15T02:31:45.000Z', status: 'running', message: 'Run started' },
        { timestamp: '2026-07-15T02:33:02.000Z', status: 'completed', message: 'Step completed' }
      ]
    },
    'review-draft': { executionStatus: 'locked', reviewStatus: 'pending', completionStatus: 'not_ready', output: '' },
    'publish-docs': { executionStatus: 'locked', reviewStatus: 'pending', completionStatus: 'not_ready', output: '' },
    'announce': { executionStatus: 'locked', reviewStatus: 'pending', completionStatus: 'not_ready', output: '' }
  }
};

/** Per-flow audit log entries backing the History sub-tab in the preview run. */
export const previewAuditLogs: Record<string, any[]> = {
  [previewFlow.id]: [
    { stepId: 'collect-context', runId: previewRunState.runId, timestamp: '2026-07-15T02:30:05.000Z', status: 'running', message: 'Run started' },
    { stepId: 'collect-context', runId: previewRunState.runId, timestamp: '2026-07-15T02:31:12.000Z', status: 'completed', message: 'Step completed' },
    { stepId: 'collect-context', runId: previewRunState.runId, timestamp: '2026-07-15T02:31:40.000Z', status: 'approved', message: 'Review (llm): approved' },
    { stepId: 'write-docs', runId: previewRunState.runId, timestamp: '2026-07-15T02:31:45.000Z', status: 'running', message: 'Run started' },
    { stepId: 'write-docs', runId: previewRunState.runId, timestamp: '2026-07-15T02:33:02.000Z', status: 'completed', message: 'Step completed — waiting for human review' }
  ]
};

/** Run-history rows for the Flows tab list in the preview. */
export const previewRunSummaries = [
  {
    flowId: previewFlow.id,
    runId: previewRunState.runId,
    runName: previewRunState.runName,
    completedSteps: 1,
    failedSteps: 0,
    inProgressSteps: 1,
    reviewing: true,
    totalSteps: previewFlow.steps.length,
    mtimeMs: 1752546930000,
    isClosed: false,
    costUsd: 0.4179,
    tokensUsed: 44560,
    taskTimeMs: 144000,
    reviewTimeMs: 28000
  }
];

export const previewAgents: Agent[] = [
  {
    name: 'aidlc-developer',
    description: 'Implements and checks code changes for ClaudeSteps workflows.',
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
