import { applyDependencyLocks as applyCoreDependencyLocks } from '@ai-stepflow/core/runStateMachine';
import { Flow, FlowStep, FlowRunState } from '@ai-stepflow/core/types';

export const applyDependencyLocks = applyCoreDependencyLocks;

/** Run ids are ISO timestamps; show them as a readable local time. */
export const formatRunTime = (iso: string) => {
  const date = new Date(iso);
  return isNaN(date.getTime()) ? iso : date.toLocaleString();
};

export const hasUnfinishedSteps = (runState: FlowRunState) =>
  Object.values(runState.steps).some(step => step.completionStatus !== 'done');

/** Select the step a restored run should show by default. */
export const getDefaultActiveStepId = (flow: Flow, runState: FlowRunState): string | null => {
  const runningStep = flow.steps.find(step => runState.steps[step.id]?.executionStatus === 'running');
  if (runningStep) return runningStep.id;

  const nextStep = flow.steps.find(step => runState.steps[step.id]?.completionStatus !== 'done');
  return nextStep?.id ?? flow.steps[flow.steps.length - 1]?.id ?? null;
};

export const hasDependencyCycle = (steps: FlowStep[]): boolean => {
  const graph = new Map(steps.map(step => [step.id, step.dependsOn ?? []]));
  const visited = new Set<string>();
  const stack = new Set<string>();
  const visit = (id: string): boolean => {
    if (stack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    stack.add(id);
    const cycle = (graph.get(id) ?? []).some(dep => graph.has(dep) && visit(dep));
    stack.delete(id);
    return cycle;
  };
  return steps.some(step => visit(step.id));
};

/** A step may carry several skills (run in order); older flows only have `skill`. */
export const getStepSkills = (step: FlowStep): string[] =>
  step.skills && step.skills.length ? step.skills : (step.skill ? [step.skill] : []);

/** Group steps into dependency-depth columns for the flow board layout. */
export const getFlowColumns = (flow: Flow): FlowStep[][] => {
  const hasDependencies = flow.steps.some(step => step.dependsOn?.length);
  if (!hasDependencies) {
    return flow.steps.map(step => [step]);
  }

  const stepById = new Map(flow.steps.map(step => [step.id, step]));
  const depthById = new Map<string, number>();
  const visiting = new Set<string>();

  const getDepth = (step: FlowStep): number => {
    if (depthById.has(step.id)) return depthById.get(step.id)!;
    if (visiting.has(step.id)) return 0;
    visiting.add(step.id);
    const dependencies = step.dependsOn?.map(id => stepById.get(id)).filter(Boolean) as FlowStep[] | undefined;
    const depth = dependencies?.length ? Math.max(...dependencies.map(getDepth)) + 1 : 0;
    visiting.delete(step.id);
    depthById.set(step.id, depth);
    return depth;
  };

  flow.steps.forEach(getDepth);
  const columns: FlowStep[][] = [];
  flow.steps.forEach(step => {
    const depth = depthById.get(step.id) || 0;
    columns[depth] = columns[depth] || [];
    columns[depth].push(step);
  });
  return columns.filter(Boolean);
};
