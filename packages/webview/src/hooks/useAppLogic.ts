import { Flow, FlowRunState, StepRunState, Agent, Skill } from '@ai-stepflow/core/types';
import { isVSCodeWebview, sendToVSCode } from '../vscode';
import {
  getStepSkills,
  applyDependencyLocks,
  getDefaultActiveStepId,
  hasDependencyCycle
} from '../flowUtils';
import { previewFlow, previewAgents, previewSkills } from '../previewData';

import { useLibraryState } from './appState/useLibraryState';
import { useRunState } from './appState/useRunState';
import { useBuilderState } from './appState/useBuilderState';
import { useChatState } from './appState/useChatState';
import { ScopeFilter, ViewFilter, ViewFilterItem, SortOrder, SaveScope } from './appState/types';

const VALID_FILTERS: ScopeFilter[] = ['all', 'project', 'global'];
const parseFilter = (v: string | undefined): ScopeFilter =>
  VALID_FILTERS.includes(v as ScopeFilter) ? (v as ScopeFilter) : 'all';

export const useAppLogic = () => {
  const libState = useLibraryState();
  const runState = useRunState();
  const buildState = useBuilderState();
  const chatState = useChatState();

  const updateRunState = (stepId: string, updates: Partial<StepRunState> | ((prev: StepRunState | undefined) => Partial<StepRunState>)) => {
    runState.shouldPersistRun.current = true;
    runState.setRunState(prev => {
      if (!prev) return null;
      const prevStep = prev.steps[stepId];
      const resolved = typeof updates === 'function' ? updates(prevStep) : updates;
      const steps = { ...prev.steps, [stepId]: { ...prevStep, ...resolved } };
      const flow = runState.activeFlowRef.current;
      return { ...prev, steps: flow ? applyDependencyLocks(flow, steps) : steps };
    });
  };

  const initRunState = (flow: Flow, runName?: string, inputs: Record<string, string> = {}) => {
    const initialSteps: Record<string, StepRunState> = {};
    flow.steps.forEach(step => {
      initialSteps[step.id] = {
        executionStatus: 'ready',
        reviewStatus: step.review.required ? 'pending' : 'not_required',
        completionStatus: 'not_ready',
        output: ''
      };
    });

    runState.shouldPersistRun.current = true;
    const newRunState: FlowRunState = {
      flowId: flow.id,
      runId: new Date().toISOString(),
      runName,
      flowName: flow.name,
      source: flow.sourcePath,
      projectPath: '',
      inputs,
      steps: applyDependencyLocks(flow, initialSteps)
    };
    runState.setRunState(newRunState);
    runState.setActiveStepId(flow.steps[0]?.id || null);
    libState.setRunSummaries(prev => [{
      flowId: newRunState.flowId,
      runId: newRunState.runId,
      runName: newRunState.runName,
      completedSteps: 0,
      totalSteps: flow.steps.length,
      mtimeMs: Date.now(),
      isClosed: false
    }, ...prev]);
    sendToVSCode('updateRunState', { runState: newRunState });
  };

  const startFreshRun = (flow: Flow) => {
    runState.setActiveFlow(flow);
    const inputNames = Object.keys(flow.inputs || {});
    runState.setRunInputValues(Object.fromEntries(inputNames.map(name => [name, ''])));
    runState.setRunName('');
    runState.setRunInputsError(null);
    runState.setRunInputsTarget(flow);
  };

  const startOrResumeRun = (flow: Flow) => {
    if (runState.activeFlow?.id === flow.id && runState.runState) {
      runState.setRunnerVisible(true);
      return;
    }
    startFreshRun(flow);
    runState.setRunnerVisible(true);
  };

  const handleHostMessage = (message: any) => {
    switch (message.type) {
      case 'loadData':
        libState.setFlows(message.flows);
        libState.setAgents(message.agents);
        libState.setSkills(message.skills);
        libState.setAuditLogs(message.auditLogs || {});
        libState.setRunSummaries(message.runSummaries || []);
        libState.setGlobalPath(message.globalPath);
        libState.setProjectPath(message.projectPath);
        libState.setConnectedMcpServers(message.connectedMcpServers || []);
        if (message.uiPrefs) {
          libState.setScopeFilters({
            flows: parseFilter(message.uiPrefs['scopeFilter:flows']),
            agents: parseFilter(message.uiPrefs['scopeFilter:agents']),
            skills: parseFilter(message.uiPrefs['scopeFilter:skills']),
          });
          const parseViewFilter = (v: unknown): ViewFilter => {
            if (Array.isArray(v)) return (v as string[]).filter((x): x is ViewFilterItem => x === 'bookmarked' || x === 'built-in');
            if (v === 'bookmarked' || v === 'built-in') return [v]; // migrate old persisted string
            return [];
          };
          const parseSortOrder = (v: string | undefined): SortOrder =>
            v === 'desc' ? 'desc' : 'asc';
          libState.setViewFilters({
            flows: parseViewFilter(message.uiPrefs['viewFilter:flows']),
            agents: parseViewFilter(message.uiPrefs['viewFilter:agents']),
            skills: parseViewFilter(message.uiPrefs['viewFilter:skills']),
          });
          libState.setSortOrders({
            flows: parseSortOrder(message.uiPrefs['sortOrder:flows']),
            agents: parseSortOrder(message.uiPrefs['sortOrder:agents']),
            skills: parseSortOrder(message.uiPrefs['sortOrder:skills']),
          });
          const parseGroupBy = (v: string | undefined): 'list' | 'tag' => (v === 'tag' ? 'tag' : 'list');
          libState.setGroupBys({
            agents: parseGroupBy(message.uiPrefs['groupBy:agents']),
            skills: parseGroupBy(message.uiPrefs['groupBy:skills']),
          });
          const savedTab = message.uiPrefs['activeTab'];
          if (savedTab === 'flows' || savedTab === 'agents' || savedTab === 'skills') {
            libState.setActiveTab(savedTab);
          }
          try {
            const rawBm = message.uiPrefs['bookmarks'];
            if (rawBm) {
              const bm = JSON.parse(rawBm);
              if (bm && typeof bm === 'object' && !Array.isArray(bm)) libState.setBookmarks(bm);
            }
          } catch { /* corrupt prefs — keep empty */ }
        }
        break;
      case 'mcpServers':
        libState.setConnectedMcpServers(message.connectedMcpServers || []);
        break;
      case 'navigateToTab':
        if (message.tab === 'flows' || message.tab === 'agents' || message.tab === 'skills') {
          libState.setActiveTab(message.tab);
        }
        break;
      case 'restoreRun':
        runState.setActiveFlow(message.flow);
        runState.setRunState(message.runState);
        runState.setRunnerVisible(true);
        runState.setActiveStepId(getDefaultActiveStepId(message.flow, message.runState));
        break;
      case 'runDeleted': {
        const { flowId, runId } = message;
        libState.setRunSummaries(prev => prev.filter(s => !(s.flowId === flowId && s.runId === runId)));
        libState.setAuditLogs(prev => {
          if (!prev[flowId]) return prev;
          const filtered = prev[flowId].filter((e: any) => e.runId !== runId);
          return { ...prev, [flowId]: filtered };
        });
        runState.setRunState(null);
        runState.setActiveFlow(null);
        runState.setActiveStepId(null);
        runState.setRunnerVisible(false);
        break;
      }
      case 'runClosed':
        if (message.finalized && message.flowId && message.runId) {
          libState.setRunSummaries(prev => prev.map(s =>
            s.flowId === message.flowId && s.runId === message.runId
              ? { ...s, isClosed: true }
              : s
          ));
        }
        runState.setRunState(null);
        runState.setActiveFlow(null);
        runState.setActiveStepId(null);
        runState.setRunnerVisible(false);
        break;
      case 'resetAuditLog':
        runState.setRunState(currentRun => {
          if (currentRun) {
            const oldRunId = currentRun.runId;
            libState.setAuditLogs(prev => {
              const flowId = message.flowId;
              if (!prev[flowId]) return prev;
              return { ...prev, [flowId]: prev[flowId].filter(e => e.runId !== oldRunId) };
            });
          }
          return currentRun;
        });
        break;
      case 'stepUpdate':
        runState.setRunState(prev => {
          if (!prev) return prev;
          const ps = prev.steps[message.stepId];
          const output = message.append ? `${ps?.output || ''}${message.output || ''}` : (message.output || '');
          return { ...prev, steps: { ...prev.steps, [message.stepId]: { ...ps, output } } };
        });
        break;
      case 'aiReviewUpdate':
        runState.setRunState(prev => {
          if (!prev) return prev;
          const ps = prev.steps[message.stepId];
          const aiReviewOutput = message.append ? `${ps?.aiReviewOutput || ''}${message.output || ''}` : (message.output || '');
          return { ...prev, steps: { ...prev.steps, [message.stepId]: { ...ps, aiReviewOutput } } };
        });
        break;
      case 'runStateChanged':
        runState.setRunState(message.runState);
        if (message.historyEvent && runState.activeFlowRef.current) {
          const flowId = runState.activeFlowRef.current.id;
          const newEvent = { ...message.historyEvent, runId: message.runState.runId };
          libState.setAuditLogs(prev => ({ ...prev, [flowId]: [...(prev[flowId] || []), newEvent] }));
        }
        if (runState.activeFlowRef.current) {
          runState.setActiveStepId(curr => curr ?? getDefaultActiveStepId(runState.activeFlowRef.current!, message.runState));
        }
        break;
      case 'fileImported':
        if (message.kind === 'agent') {
          buildState.setAgentForm(prev => ({ ...prev, ...message.item, scope: 'project' }));
          buildState.setAgentFormError(null);
          buildState.setEditingAgentSource(null);
          buildState.setAgentModalOpen(true);
          libState.setActiveTab('agents');
        } else {
          buildState.setSkillForm(prev => ({ ...prev, ...message.item, scope: 'project' }));
          buildState.setSkillFormError(null);
          buildState.setEditingSkillSource(null);
          buildState.setSkillModalOpen(true);
          libState.setActiveTab('skills');
        }
        break;
      case 'draftGenerated':
        buildState.setDraftLoading(null);
        if (message.error) {
          if (message.kind === 'agent') buildState.setAgentFormError(`Draft failed: ${message.error}`);
          else buildState.setSkillFormError(`Draft failed: ${message.error}`);
          break;
        }
        if (message.kind === 'agent') {
          buildState.setAgentForm(prev => ({
            ...prev,
            ...(message.name ? { name: message.name } : {}),
            ...(message.description ? { description: message.description } : {}),
            ...(message.content ? { systemPrompt: message.content } : {}),
            ...(typeof message.maxTurns === 'number' ? { maxTurns: message.maxTurns } : {})
          }));
          chatState.setAgentAiMessages(prev => [...prev, { role: 'assistant', content: message.reply || 'Agent generated — see below.' }]);
          buildState.setAgentFormError(null);
        } else {
          buildState.setSkillForm(prev => ({
            ...prev,
            ...(message.name ? { name: message.name } : {}),
            ...(message.description ? { description: message.description } : {}),
            ...(message.content ? { instructions: message.content } : {})
          }));
          chatState.setSkillAiMessages(prev => [...prev, { role: 'assistant', content: message.reply || 'Skill generated — see below.' }]);
          buildState.setSkillFormError(null);
        }
        break;
      case 'flowGenerated':
        chatState.setFlowAiLoading(false);
        if (message.error) {
          buildState.setBuilderError(`Flow generation failed: ${message.error}`);
          break;
        }
        if (message.flow) {
          buildState.setEditingFlow(message.flow);
          buildState.setBuilderError(null);
        }
        if (message.reply) {
          chatState.setFlowAiMessages(prev => [...prev, { role: 'assistant', content: message.reply }]);
        }
        break;
    }
  };

  const submitAgentModal = () => {
    if (!buildState.agentForm.name.trim()) {
      buildState.setAgentFormError('Agent name is required.');
      return;
    }
    buildState.setAgentFormError(null);
    if (!isVSCodeWebview()) {
      const agent: Agent = {
        name: buildState.agentForm.name.trim(),
        description: buildState.agentForm.description || '',
        model: buildState.agentForm.model || 'claude-sonnet-4-6',
        tools: buildState.agentForm.tools,
        systemPrompt: buildState.agentForm.systemPrompt || 'You are a helpful AI agent.',
        sourcePath: `/preview/.claude/agents/${buildState.agentForm.name.trim()}.md`,
        ...(buildState.agentForm.maxTurns != null ? { maxTurns: buildState.agentForm.maxTurns } : {}),
        ...(buildState.agentForm.tags?.length ? { tags: buildState.agentForm.tags } : {})
      };
      libState.setAgents(prev => [
        ...prev.filter(item => item.name !== agent.name && item.sourcePath !== buildState.editingAgentSource),
        agent
      ]);
      buildState.setAgentModalOpen(false);
      buildState.setEditingAgentSource(null);
      buildState.setAgentForm(buildState.emptyAgentForm);
      return;
    }
    sendToVSCode(buildState.editingAgentSource ? 'updateAgent' : 'createAgent', {
      agent: {
        name: buildState.agentForm.name.trim(),
        description: buildState.agentForm.description || '',
        model: buildState.agentForm.model || 'claude-sonnet-4-6',
        tools: buildState.agentForm.tools,
        systemPrompt: buildState.agentForm.systemPrompt || '',
        ...(buildState.agentForm.maxTurns != null ? { maxTurns: buildState.agentForm.maxTurns } : {}),
        ...(buildState.agentForm.tags?.length ? { tags: buildState.agentForm.tags } : {}),
        ...(chatState.agentAiMessages.length ? { aiConversation: chatState.agentAiMessages } : {})
      },
      originalSourcePath: buildState.editingAgentSource,
      isGlobal: buildState.agentForm.scope === 'global'
    });
    buildState.setAgentModalOpen(false);
    buildState.setEditingAgentSource(null);
    buildState.setAgentForm(buildState.emptyAgentForm);
  };

  const openAgentEditor = (agent?: Agent) => {
    if (agent) {
      buildState.setAgentForm({
        name: agent.name,
        description: agent.description,
        model: agent.model,
        tools: agent.tools || [],
        systemPrompt: agent.systemPrompt,
        scope: libState.getItemScope(agent.sourcePath),
        maxTurns: agent.maxTurns,
        tags: agent.tags || []
      });
      buildState.setEditingAgentSource(agent.sourcePath);
    } else {
      buildState.setAgentForm(buildState.emptyAgentForm);
      buildState.setEditingAgentSource(null);
    }
    buildState.setAgentFormError(null);
    chatState.setAgentAiPrompt('');
    chatState.setAgentAiMessages(agent?.aiConversation || []);
    buildState.setAgentModalOpen(true);
  };

  const submitSkillModal = () => {
    if (!buildState.skillForm.name.trim()) {
      buildState.setSkillFormError('Skill name is required.');
      return;
    }
    buildState.setSkillFormError(null);
    if (!isVSCodeWebview()) {
      const skill: Skill = {
        name: buildState.skillForm.name.trim(),
        description: buildState.skillForm.description || '',
        instructions: buildState.skillForm.instructions || '',
        sourcePath: `/preview/.claude/skills/${buildState.skillForm.name.trim()}`,
        ...(buildState.skillForm.tags?.length ? { tags: buildState.skillForm.tags } : {})
      };
      libState.setSkills(prev => [
        ...prev.filter(item => item.name !== skill.name && item.sourcePath !== buildState.editingSkillSource),
        skill
      ]);
      buildState.setSkillModalOpen(false);
      buildState.setEditingSkillSource(null);
      buildState.setSkillForm(buildState.emptySkillForm);
      return;
    }
    sendToVSCode(buildState.editingSkillSource ? 'updateSkill' : 'createSkill', {
      skill: {
        name: buildState.skillForm.name.trim(),
        description: buildState.skillForm.description || '',
        instructions: buildState.skillForm.instructions || '',
        ...(buildState.skillForm.tags?.length ? { tags: buildState.skillForm.tags } : {}),
        ...(chatState.skillAiMessages.length ? { aiConversation: chatState.skillAiMessages } : {})
      },
      originalSourcePath: buildState.editingSkillSource,
      isGlobal: buildState.skillForm.scope === 'global'
    });
    buildState.setSkillModalOpen(false);
    buildState.setEditingSkillSource(null);
    buildState.setSkillForm(buildState.emptySkillForm);
  };

  const openSkillEditor = (skill?: Skill, newScope: SaveScope = 'project') => {
    if (skill) {
      buildState.setSkillForm({
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        scope: libState.getItemScope(skill.sourcePath),
        tags: skill.tags || []
      });
      buildState.setEditingSkillSource(skill.sourcePath);
    } else {
      buildState.setSkillForm({ ...buildState.emptySkillForm, scope: newScope });
      buildState.setEditingSkillSource(null);
    }
    buildState.setSkillFormError(null);
    chatState.setSkillAiPrompt('');
    chatState.setSkillAiMessages(skill?.aiConversation || []);
    buildState.setSkillModalOpen(true);
  };

  const submitConnectMcp = (config: { name: string; scope: 'global' | 'local'; command: string; args: string[]; env?: Record<string, string> }) => {
    sendToVSCode('connectMcpServer', { config });
    buildState.setConnectMcpModalOpen(false);
  };

  const submitRunInputs = () => {
    if (!runState.runInputsTarget) return;
    initRunState(runState.runInputsTarget, runState.runName.trim() || undefined, runState.runInputValues);
    runState.setRunInputsTarget(null);
    runState.setRunnerVisible(true);
  };

  const runActiveStep = (stepId: string, description?: string) => {
    if (!runState.activeFlow) return;
    const historyEvent = { timestamp: new Date().toISOString(), status: 'running', message: 'Started run' };
    if (!isVSCodeWebview()) {
      seedPreviewRun(stepId, description);
      return;
    }
    sendToVSCode('runStep', { flow: runState.activeFlow, runState: runState.runState, stepId, description, historyEvent });
  };

  const seedPreview = () => {
    libState.setFlows([previewFlow]);
    libState.setAgents(previewAgents);
    libState.setSkills(previewSkills);
    libState.setGlobalPath('/preview/global');
    libState.setProjectPath('/preview/project');
  };

  const seedPreviewRun = (stepId: string, runDescription?: string) => {
    updateRunState(stepId, { 
      executionStatus: 'running',
      output: `Preview mode: simulating Claude output...\n\nRun description:\n${runDescription || 'No run description.'}\n`
    });
    window.setTimeout(() => {
      updateRunState(stepId, () => {
        const step = runState.activeFlowRef.current?.steps.find(s => s.id === stepId);
        const updates: Partial<StepRunState> = {
          executionStatus: 'completed',
          output: 'Preview mode: simulated step completed successfully.\n\nInstall the VSIX or run the extension host to execute Claude for real.'
        };
        if (step && !step.review?.required) {
          updates.completionStatus = 'done';
        }
        return updates;
      });
    }, 700);
  };

  const validateFlow = (flow: Flow): string | null => {
    if (!flow.name.trim()) return 'Flow name is required.';
    if (flow.name.trim().length > 60) return 'Flow name must be 60 characters or fewer.';
    if (!/^[\x20-\x7E]+$/.test(flow.name.trim())) return 'Flow name must use English (ASCII) characters only.';
    const ids = new Set<string>();
    for (const step of flow.steps) {
      const label = step.title || step.id;
      if (!step.id) return 'Every step needs an id.';
      if (ids.has(step.id)) return `Duplicate step id '${step.id}'.`;
      ids.add(step.id);
      if (!step.agent || !libState.getAgentByName(step.agent)) return `Step '${label}': agent '${step.agent || '(none)'}' does not exist.`;
      const stepSkills = getStepSkills(step);
      for (const skillName of stepSkills) {
        if (!libState.getSkillByName(skillName)) return `Step '${label}': skill '${skillName}' does not exist.`;
      }
    }
    for (const step of flow.steps) {
      for (const dep of step.dependsOn ?? []) {
        if (dep === step.id) return `Step '${step.title || step.id}' cannot depend on itself.`;
        if (!ids.has(dep)) return `Step '${step.title || step.id}' depends on unknown step '${dep}'.`;
      }
    }
    if (hasDependencyCycle(flow.steps)) return 'Step dependencies contain a cycle.';
    return null;
  };

  const saveEditingFlow = () => {
    if (!buildState.editingFlow) return;
    const error = validateFlow(buildState.editingFlow);
    if (error) {
      buildState.setBuilderError(error);
      return;
    }
    sendToVSCode('saveFlow', {
      flow: { ...buildState.editingFlow, aiConversation: chatState.flowAiMessages },
      isGlobal: buildState.editingFlowScope === 'global'
    });
    buildState.setEditingFlow(null);
    buildState.setEditingStep(null);
    buildState.setBuilderError(null);
  };

  const saveStepEdit = () => {
    if (!buildState.editingStep || !buildState.editingFlow) return;
    const newSteps = [...buildState.editingFlow.steps];
    const step = buildState.editingStep.step;
    const reviewType = step.review.type === 'ai' ? 'ai' : 'human';
    newSteps[buildState.editingStep.index] = {
      ...step,
      review: {
        ...step.review,
        required: true,
        type: reviewType,
        reviewers: reviewType === 'ai' ? step.review.reviewers : undefined
      },
      completion: { requireMarkDone: reviewType === 'human' }
    };
    const newFlow = { ...buildState.editingFlow, steps: newSteps };

    if (buildState.stepEditFromBoard) {
      const error = validateFlow(newFlow);
      if (error) {
        buildState.setStepError(error);
        return;
      }
      sendToVSCode('saveFlow', { flow: newFlow, isGlobal: buildState.editingFlowScope === 'global' });
      buildState.setEditingStep(null);
      buildState.setStepError(null);
      buildState.setStepEditFromBoard(false);
      buildState.setStepIsNew(false);
      buildState.setEditingFlow(null);
      return;
    }

    buildState.setEditingFlow(newFlow);
    buildState.setEditingStep(null);
  };

  const completedSteps = runState.runState ? Object.values(runState.runState.steps).filter(s => s.completionStatus === 'done').length : 0;
  const activeProgress = runState.runState && runState.activeFlow?.steps.length
    ? Math.round((completedSteps / runState.activeFlow.steps.length) * 100)
    : 0;

  return {
    ...libState,
    ...runState,
    ...buildState,
    ...chatState,
    completedSteps, activeProgress,
    handleHostMessage, seedPreview,
    startOrResumeRun,
    startFreshRun,
    submitAgentModal, openAgentEditor, submitSkillModal, openSkillEditor,
    submitConnectMcp,
    submitRunInputs, runActiveStep, saveEditingFlow, saveStepEdit
  };
};
