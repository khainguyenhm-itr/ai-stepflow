import * as path from 'path';
import { promises as fs } from 'fs';
import { 
  runClaudeStreaming,
  loadAgents, loadFlowByIdOrPath, loadSkills,
  composeSystemPrompt,
  validateProduces, validateRequires,
  renderRunReport,
  Flow, FlowRunState, FlowStep,
  reviewStepArtifacts,
  resolveStepRunner,
  renderVerifyReportMarkdown, verifyRun
} from '@ai-stepflow/core';
import * as machine from '@ai-stepflow/core';

const COMMANDS = ['run', 'verify', 'report', 'approve', 'reject', 'mark-done'] as const;
type Command = typeof COMMANDS[number];

interface CliOptions {
  project: string;
  flow?: string;
  run?: string;
  out?: string;
  step?: string;
  comment?: string;
  input: Record<string, string>;
}

function parseArgs(argv: string[]): { command: Command; options: CliOptions } {
  const [commandRaw, ...rest] = argv;
  if (!COMMANDS.includes(commandRaw as Command)) {
    throw new Error('Usage: ai-stepflow <run|verify|report|approve|reject|mark-done> --project <path> [--flow <id-or-path>] [--run <file>] [--step <id>] [--out <file>] [--comment <text>] [--input key=value]');
  }
  const options: CliOptions = { project: process.cwd(), input: {} };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = rest[i + 1];
    if (arg === '--project' && value) { options.project = path.resolve(value); i++; continue; }
    if (arg === '--flow' && value) { options.flow = value; i++; continue; }
    if (arg === '--run' && value) { options.run = path.resolve(value); i++; continue; }
    if (arg === '--out' && value) { options.out = path.resolve(value); i++; continue; }
    if (arg === '--step' && value) { options.step = value; i++; continue; }
    if (arg === '--comment' && value) { options.comment = value; i++; continue; }
    if (arg === '--input' && value) {
      const eq = value.indexOf('=');
      if (eq <= 0) throw new Error(`Invalid --input '${value}', expected key=value`);
      options.input[value.slice(0, eq)] = value.slice(eq + 1);
      i++;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { command: commandRaw as Command, options };
}

async function loadRunFile(filePath: string): Promise<FlowRunState> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as FlowRunState;
}

async function saveRun(projectPath: string, run: FlowRunState): Promise<string> {
  const runsDir = path.join(projectPath, '.ai-stepflow', 'runs');
  await fs.mkdir(runsDir, { recursive: true });
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '-');
  const filePath = path.join(runsDir, `${safe(run.flowId)}-${safe(run.runId)}.json`);
  await fs.writeFile(filePath, JSON.stringify(run, null, 2), 'utf8');
  return filePath;
}

async function saveReport(projectPath: string, flowId: string, runId: string, content: string, out?: string): Promise<string> {
  const filePath = out ?? path.join(projectPath, '.ai-stepflow', 'reports', `${flowId.replace(/[^a-zA-Z0-9_-]+/g, '-')}-${runId.replace(/[^a-zA-Z0-9_-]+/g, '-')}.md`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

async function runAiReview(runState: FlowRunState, step: FlowStep, projectPath: string): Promise<{ status: 'approved' | 'rejected' | 'waiting_human'; output: string }> {
  // Shared two-layer review (deterministic validator + optional LLM on the artifacts), identical
  // to the extension so a flow reviews the same way headless or in the UI.
  const result = await reviewStepArtifacts({
    workspaceRoot: projectPath,
    step,
    runState,
    deep: step.review.deep !== false,
    runner: opts => runClaudeStreaming(opts).completed,
    onText: chunk => process.stdout.write(chunk)
  });
  return { status: result.status, output: `Review (${result.source}): ${result.status} — ${result.note}` };
}

async function runFlow(projectPath: string, flowRef: string, inputs: Record<string, string>): Promise<number> {
  const flow = await loadFlowByIdOrPath({ projectPath, flowRef });
  if (!flow) throw new Error(`Flow not found: ${flowRef}`);
  const [agents, skills] = await Promise.all([loadAgents({ projectPath }), loadSkills({ projectPath })]);
  let runState = machine.initRunState(flow, { runId: new Date().toISOString(), projectPath, inputs });
  
  const orch = new machine.FlowOrchestrator(flow, runState);

  while (true) {
    const actions = orch.getAutoAdvanceActions();
    const action = actions.find(a => a.type === 'launch_headless' || a.type === 'launch_interactive');
    if (!action) break;

    const next = flow.steps.find(s => s.id === action.stepId);
    if (!next) break;

    const stepState = runState.steps[next.id];
    if (!stepState || stepState.completionStatus === 'done') continue;

    const req = validateRequires(next, projectPath, runState.inputs);
    if (!req.ok) {
      runState = machine.markFailed(runState, flow, next.id, { output: `[requires check failed: ${req.message}]` });
      await saveRun(projectPath, runState);
      process.stderr.write(`Step '${next.title || next.id}' blocked: ${req.message}\n`);
      return 1;
    }

    const agent = agents.find(item => item.name === next.agent);
    const stepSkillNames = next.skills && next.skills.length ? next.skills : (next.skill ? [next.skill] : []);
    if (!agent || stepSkillNames.length === 0) {
      process.stderr.write(`Step '${next.title || next.id}' is missing an agent or skill.\n`);
      return 1;
    }

    let runner: machine.StepRunner;
    try {
      runner = await resolveStepRunner(agent.runnerPath, projectPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runState = machine.markFailed(runState, flow, next.id, { output: `[runner load failed: ${message}]` });
      await saveRun(projectPath, runState);
      process.stderr.write(`Step '${next.title || next.id}' runner failed to load: ${message}\n`);
      return 1;
    }

    runState = machine.markRunning(runState, flow, next.id);
    await saveRun(projectPath, runState);
    process.stdout.write(`\n=== ${next.title || next.id} ===\n`);

    let output = '';
    const result = await runner({
      systemPrompt: composeSystemPrompt(agent, stepSkillNames, skills),
      userMessage: next.input?.prompt?.trim() || `Run step: ${next.title || next.id}`,
      model: agent.model,
      projectPath,
      onText: chunk => { output += chunk; process.stdout.write(chunk); }
    });

    const metrics: machine.StepMetrics = { modelUsed: result.model, tokensUsed: result.tokensUsed, costUsd: result.costUsd, output };
    if (!result.success) {
      const why = `claude exited ${result.exitCode}`;
      runState = machine.markFailed(runState, flow, next.id, { ...metrics, error: why, output: `${output}\n[step failed: ${why}]\n` });
      await saveRun(projectPath, runState);
      return 1;
    }

    const prod = validateProduces(next, projectPath, runState.inputs);
    if (!prod.ok) {
      const why = `produces check failed: ${prod.message}`;
      runState = machine.markFailed(runState, flow, next.id, { ...metrics, error: why, output: `${output}\n[${why}]\n` });
      await saveRun(projectPath, runState);
      return 1;
    }

    runState = machine.markCompleted(runState, flow, next.id, metrics);

    if (!next.review.required) {
      await saveRun(projectPath, runState);
      continue;
    }

    if (!orch.isHeadlessStep(next) && !next.review.validatorPath) {
      await saveRun(projectPath, runState);
      process.stderr.write(`Step '${next.title || next.id}' requires human review and cannot finish in headless mode.\n`);
      return 3;
    }

    const review = await runAiReview(runState, next, projectPath);
    runState = machine.applyAiReview(runState, flow, next.id, review.status, review.output);
    await saveRun(projectPath, runState);
    if (review.status !== 'approved') {
      process.stderr.write(`Auto-review rejected step '${next.title || next.id}'.\n`);
      return review.status === 'waiting_human' ? 3 : 1;
    }
  }

  const runFile = await saveRun(projectPath, runState);
  process.stdout.write(`\nRun saved to ${runFile}\n`);
  return 0;
}

async function verifyFromFiles(projectPath: string, flowRef: string, runFile: string): Promise<number> {
  const flow = await loadFlowByIdOrPath({ projectPath, flowRef });
  if (!flow) throw new Error(`Flow not found: ${flowRef}`);
  const runState = await loadRunFile(runFile);
  const report = verifyRun(flow, runState, projectPath);
  const markdown = renderVerifyReportMarkdown(flow, runState, report);
  process.stdout.write(markdown + '\n');
  return report.ok ? 0 : 1;
}

async function reportFromFiles(projectPath: string, flowRef: string, runFile: string, out?: string): Promise<number> {
  const flow = await loadFlowByIdOrPath({ projectPath, flowRef });
  if (!flow) throw new Error(`Flow not found: ${flowRef}`);
  const runState = await loadRunFile(runFile);
  const markdown = renderRunReport(flow, runState, []);
  const filePath = await saveReport(projectPath, flow.id, runState.runId, markdown, out);
  process.stdout.write(`Report written to ${filePath}\n`);
  return 0;
}

/** Apply a human review decision to a saved run, then persist it back to the same file. */
async function applyReviewDecision(
  projectPath: string,
  flowRef: string,
  runFile: string,
  stepId: string,
  decision: 'approved' | 'rejected',
  comment?: string
): Promise<number> {
  const flow = await loadFlowByIdOrPath({ projectPath, flowRef });
  if (!flow) throw new Error(`Flow not found: ${flowRef}`);
  if (!flow.steps.some(s => s.id === stepId)) { process.stderr.write(`Step not found: ${stepId}\n`); return 1; }
  let runState = await loadRunFile(runFile);
  runState = machine.applyHumanReview(runState, flow, stepId, { decision, comment });
  // An explicit headless approval also finalizes the step (the UI's two-click flow collapses to one).
  if (decision === 'approved') runState = machine.markDone(runState, flow, stepId);
  await fs.writeFile(runFile, JSON.stringify(runState, null, 2), 'utf8');
  process.stdout.write(`Step '${stepId}' ${decision}${decision === 'approved' ? ' and marked done' : ''}.\n`);
  return 0;
}

/** Validate a step's artifacts and mark it done (for no-review or already-approved steps). */
async function markStepDoneFromFiles(projectPath: string, flowRef: string, runFile: string, stepId: string): Promise<number> {
  const flow = await loadFlowByIdOrPath({ projectPath, flowRef });
  if (!flow) throw new Error(`Flow not found: ${flowRef}`);
  const step = flow.steps.find(s => s.id === stepId);
  if (!step) { process.stderr.write(`Step not found: ${stepId}\n`); return 1; }
  let runState = await loadRunFile(runFile);
  const req = validateRequires(step, projectPath, runState.inputs);
  if (!req.ok) { process.stderr.write(`Cannot mark done — requires check failed: ${req.message}\n`); return 1; }
  const prod = validateProduces(step, projectPath, runState.inputs);
  if (!prod.ok) { process.stderr.write(`Cannot mark done — produces check failed: ${prod.message}\n`); return 1; }
  runState = machine.markDone(runState, flow, stepId);
  await fs.writeFile(runFile, JSON.stringify(runState, null, 2), 'utf8');
  process.stdout.write(`Step '${stepId}' marked done.\n`);
  return 0;
}

async function main(): Promise<number> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'run') {
    if (!options.flow) throw new Error('run requires --flow');
    return runFlow(options.project, options.flow, options.input);
  }
  if (command === 'verify') {
    if (!options.flow || !options.run) throw new Error('verify requires --flow and --run');
    return verifyFromFiles(options.project, options.flow, options.run);
  }
  if (command === 'approve' || command === 'reject') {
    if (!options.flow || !options.run || !options.step) throw new Error(`${command} requires --flow, --run and --step`);
    return applyReviewDecision(options.project, options.flow, options.run, options.step, command === 'approve' ? 'approved' : 'rejected', options.comment);
  }
  if (command === 'mark-done') {
    if (!options.flow || !options.run || !options.step) throw new Error('mark-done requires --flow, --run and --step');
    return markStepDoneFromFiles(options.project, options.flow, options.run, options.step);
  }
  if (!options.flow || !options.run) throw new Error('report requires --flow and --run');
  return reportFromFiles(options.project, options.flow, options.run, options.out);
}

void main().then(code => {
  process.exitCode = code;
}).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
