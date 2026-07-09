import { Flow, Agent, Skill, FlowRunState } from '@ai-stepflow/core/types';

/** Sample data used by the standalone browser preview (no VS Code host). */

export const previewFlow: Flow = {
  id: 'preview-feature-flow',
  name: 'Feature Build & QA',
  description: 'Plan → implement → test → review → finalize a feature end-to-end.',
  inputs: { feature: { type: 'string', required: true, label: 'Feature' } },
  sourcePath: '/preview/.claude/flows/feature-build-qa.yaml',
  steps: [
    { id: 'plan',      title: 'Plan',      agent: 'research-analyst',   skill: 'create-plan',        skills: ['create-plan'],        review: { required: true, type: 'ai' } },
    { id: 'implement', title: 'Implement', agent: 'aidlc-developer',    skill: 'gitnexus-exploring', skills: ['gitnexus-exploring'], dependsOn: ['plan'],      review: { required: true, type: 'ai' } },
    { id: 'test',      title: 'Test',      agent: 'sandbox-runner',     skill: 'gitnexus-exploring', skills: ['gitnexus-exploring'], dependsOn: ['implement'], review: { required: true, type: 'ai' } },
    { id: 'review',    title: 'Review',    agent: 'research-reviewer',  skill: 'deep-research',      skills: ['deep-research'],      dependsOn: ['implement'], review: { required: true, type: 'human' } },
    { id: 'finalize',  title: 'Finalize',  agent: 'aidlc-docs-writer',  skill: 'consolidate-srs',    skills: ['consolidate-srs'],    dependsOn: ['test', 'review'], review: { required: true, type: 'ai' } }
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

/** ── Runs for the preview flow (mirrors new-ui.html's Run section) ── */
const NOW = Date.now();
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

/** Two runs: one in progress (opens inline), one finalized. */
export const previewRunSummaries = [
  { flowId: previewFlow.id, runId: '2026-07-09T10-00-00-a3f1', runName: 'feature-auth', completedSteps: 2, totalSteps: 5, mtimeMs: NOW - 12 * 60_000, isClosed: false, tokensUsed: 876_000, costUsd: 2.61, taskTimeMs: 248_000, reviewTimeMs: 41_000 },
  { flowId: previewFlow.id, runId: '2026-07-08T08-00-00-b7c2', runName: 'signup-flow', completedSteps: 5, totalSteps: 5, mtimeMs: NOW - 2 * 3_600_000, isClosed: true, tokensUsed: 1_230_000, costUsd: 3.40, taskTimeMs: 372_000, reviewTimeMs: 65_000 }
];

/** The in-progress run, opened inline in the runner. */
export const previewRunState: FlowRunState = {
  flowId: previewFlow.id,
  runId: '2026-07-09T10-00-00-a3f1',
  runName: 'feature-auth',
  flowName: previewFlow.name,
  source: 'flow',
  projectPath: '/preview/project',
  inputs: { feature: 'auth' },
  isClosed: false,
  autoReview: true,
  steps: {
    plan:      { executionStatus: 'completed', reviewStatus: 'approved', completionStatus: 'done', revision: 1, tokensUsed: 203_000, costUsd: 0.61, modelUsed: 'claude-opus-4', startedAt: isoAgo(600_000), completedAt: isoAgo(559_000), reviewCompletedAt: isoAgo(555_000), output: 'Plan approved — 5 steps scoped.', history: [{ timestamp: isoAgo(600_000), status: 'running' }, { timestamp: isoAgo(559_000), status: 'approved', message: 'Plan looks complete.' }] },
    implement: { executionStatus: 'completed', reviewStatus: 'approved', completionStatus: 'done', revision: 2, tokensUsed: 468_000, costUsd: 1.40, modelUsed: 'claude-opus-4', startedAt: isoAgo(540_000), completedAt: isoAgo(414_000), reviewCompletedAt: isoAgo(410_000), output: 'Implementation complete. 6 files changed.', history: [{ timestamp: isoAgo(540_000), status: 'running' }, { timestamp: isoAgo(414_000), status: 'approved' }] },
    test:      { executionStatus: 'running', reviewStatus: 'pending', completionStatus: 'not_ready', revision: 1, tokensUsed: 205_000, costUsd: 0.60, modelUsed: 'claude-opus-4', startedAt: isoAgo(90_000), output: '› Running test suite for auth...\n  PASS auth.login.test.ts\n  RUNS auth.session.test.ts', history: [{ timestamp: isoAgo(90_000), status: 'running' }] },
    review:    { executionStatus: 'locked', reviewStatus: 'pending', completionStatus: 'not_ready', history: [] },
    finalize:  { executionStatus: 'locked', reviewStatus: 'pending', completionStatus: 'not_ready', history: [] }
  }
};

export const previewAuditLogs: Record<string, any[]> = {
  [previewFlow.id]: [
    { runId: previewRunState.runId, stepId: 'test', timestamp: isoAgo(90_000), status: 'running', message: 'Test running · Review pending' },
    { runId: previewRunState.runId, stepId: 'implement', timestamp: isoAgo(414_000), status: 'approved', message: 'Implement (rev 2) approved' },
    { runId: previewRunState.runId, stepId: 'plan', timestamp: isoAgo(559_000), status: 'approved', message: 'Run created — 5 steps' }
  ]
};
