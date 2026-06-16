import { useEffect, useRef, useState } from 'react';
import { Flow, FlowStep, FlowRunState, StepRunState, Agent, Skill } from '@ai-stepflow/core/types';
import { isVSCodeWebview, sendToVSCode } from '../vscode';
import { 
  getStepSkills, 
  applyDependencyLocks, 
  getDefaultActiveStepId,
  hasDependencyCycle
} from '../flowUtils';
import { previewFlow, previewAgents, previewSkills } from '../previewData';

type Tab = 'flows' | 'agents' | 'skills';
type SaveScope = 'project' | 'global';
type FlowAiMessage = { role: 'user' | 'assistant'; content: string };

const BOOKMARKS_STORAGE_KEY = 'ai-stepflow:resource-bookmarks';

type ResourceBookmarks = Record<string, boolean>;

const loadBookmarks = (): ResourceBookmarks => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(BOOKMARKS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export const useAppLogic = () => {
  const [activeTab, setActiveTab] = useState<Tab>('flows');
  const [flows, setFlows] = useState<Flow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [bookmarks, setBookmarks] = useState<ResourceBookmarks>(loadBookmarks);
  /** Persistent local machine logs (non-repo). Keyed by flowId. */
  const [auditLogs, setAuditLogs] = useState<Record<string, any[]>>({});
  const [globalPath, setGlobalPath] = useState<string>('');
  const [projectPath, setProjectPath] = useState<string>('');
  const [connectedMcpServers, setConnectedMcpServers] = useState<string[]>([]);

  const [activeFlow, setActiveFlow] = useState<Flow | null>(null);
  const [runState, setRunState] = useState<FlowRunState | null>(null);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [runnerVisible, setRunnerVisible] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);

  // Modals
  const [standaloneRun, setStandaloneRun] = useState<{ type: 'agent'; agent: Agent } | { type: 'skill'; skill: Skill } | null>(null);
  const [standaloneRunDescription, setStandaloneRunDescription] = useState('');

  const [editingFlow, setEditingFlow] = useState<Flow | null>(null);
  const [editingFlowScope, setEditingFlowScope] = useState<SaveScope>('project');
  const [editingStep, setEditingStep] = useState<{ step: FlowStep, index: number } | null>(null);
  const [stepEditFromBoard, setStepEditFromBoard] = useState(false);
  const [stepIsNew, setStepIsNew] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [newInputName, setNewInputName] = useState('');
  const [flowAiPrompt, setFlowAiPrompt] = useState('');
  const [flowAiMessages, setFlowAiMessages] = useState<FlowAiMessage[]>([]);
  const [flowAiLoading, setFlowAiLoading] = useState(false);

  const [runInputsTarget, setRunInputsTarget] = useState<Flow | null>(null);
  const [runInputValues, setRunInputValues] = useState<Record<string, string>>({});
  const [runInputsError, setRunInputsError] = useState<string | null>(null);

  const [detailItem, setDetailItem] = useState<{
    type: 'Flow' | 'Agent' | 'Skill';
    title: string;
    description: string;
    sourcePath: string;
    meta: Record<string, string | number>;
    onDelete: () => void;
  } | null>(null);

  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [connectMcpModalOpen, setConnectMcpModalOpen] = useState(false);
  const [editingSkillSource, setEditingSkillSource] = useState<string | null>(null);
  const [editingAgentSource, setEditingAgentSource] = useState<string | null>(null);

  const emptyAgentForm = { name: '', description: '', model: 'claude-sonnet-4-6', tools: [] as string[], systemPrompt: '', scope: 'project' as SaveScope };
  const emptySkillForm = { name: '', description: '', instructions: '', scope: 'project' as SaveScope };
  const [agentForm, setAgentForm] = useState(emptyAgentForm);
  const [skillForm, setSkillForm] = useState(emptySkillForm);
  const [agentFormError, setAgentFormError] = useState<string | null>(null);
  const [skillFormError, setSkillFormError] = useState<string | null>(null);
  const [draftLoading, setDraftLoading] = useState<'agent' | 'skill' | null>(null);

  const outputEndRef = useRef<HTMLDivElement>(null);
  const activeFlowRef = useRef<Flow | null>(null);
  const shouldPersistRun = useRef(false);

  useEffect(() => {
    activeFlowRef.current = activeFlow;
  }, [activeFlow]);

  useEffect(() => {
    window.localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(bookmarks));
  }, [bookmarks]);

  const getItemScope = (sourcePath: string): SaveScope => {
    if (globalPath && sourcePath.startsWith(globalPath)) return 'global';
    return 'project';
  };

  const getFlowScope = (flow: Flow): SaveScope => getItemScope(flow.sourcePath);
  const getAgentByName = (name: string) => agents.find(agent => agent.name === name);
  const getSkillByName = (name: string) => skills.find(skill => skill.name === name);
  const getBookmarkKey = (kind: 'agent' | 'skill', sourcePath: string) => `${kind}:${sourcePath}`;
  const isBookmarked = (kind: 'agent' | 'skill', sourcePath: string) => !!bookmarks[getBookmarkKey(kind, sourcePath)];
  const toggleBookmark = (kind: 'agent' | 'skill', sourcePath: string) => {
    const key = getBookmarkKey(kind, sourcePath);
    setBookmarks(prev => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  };

  const updateRunState = (stepId: string, updates: Partial<StepRunState> | ((prev: StepRunState | undefined) => Partial<StepRunState>)) => {
    shouldPersistRun.current = true;
    setRunState(prev => {
      if (!prev) return null;
      const prevStep = prev.steps[stepId];
      const resolved = typeof updates === 'function' ? updates(prevStep) : updates;
      const steps = { ...prev.steps, [stepId]: { ...prevStep, ...resolved } };
      const flow = activeFlowRef.current;
      return { ...prev, steps: flow ? applyDependencyLocks(flow, steps) : steps };
    });
  };

  const initRunState = (flow: Flow, inputs: Record<string, string> = {}) => {
    const initialSteps: Record<string, StepRunState> = {};
    flow.steps.forEach(step => {
      initialSteps[step.id] = {
        executionStatus: 'ready',
        reviewStatus: step.review.required ? 'pending' : 'not_required',
        completionStatus: 'not_ready',
        output: ''
      };
    });

    shouldPersistRun.current = true;
    setRunState({
      flowId: flow.id,
      runId: new Date().toISOString(),
      source: flow.sourcePath,
      projectPath: '',
      inputs,
      steps: applyDependencyLocks(flow, initialSteps)
    });
    setActiveStepId(flow.steps[0]?.id || null);
  };

  const startFreshRun = (flow: Flow) => {
    setActiveFlow(flow);
    const inputNames = Object.keys(flow.inputs || {});
    if (inputNames.length) {
      setRunInputValues(Object.fromEntries(inputNames.map(name => [name, ''])));
      setRunInputsError(null);
      setRunInputsTarget(flow);
      return;
    }
    initRunState(flow);
  };

  const startOrResumeRun = (flow: Flow) => {
    if (activeFlow?.id === flow.id && runState) {
      setRunnerVisible(true);
      return;
    }
    startFreshRun(flow);
    setRunnerVisible(true);
  };

  const handleHostMessage = (message: any) => {
    console.log('[AI StepFlow Webview] received message:', message.type, message);
    switch (message.type) {
      case 'loadData':
        console.log('[AI StepFlow Webview] loading data:', message.flows.length, 'flows');
        setFlows(message.flows);
        setAgents(message.agents);
        setSkills(message.skills);
        setAuditLogs(message.auditLogs || {});
        setGlobalPath(message.globalPath);
        setProjectPath(message.projectPath);
        setConnectedMcpServers(message.connectedMcpServers || []);
        break;
      case 'mcpServers':
        setConnectedMcpServers(message.connectedMcpServers || []);
        break;
      case 'navigateToTab':
        if (message.tab === 'flows' || message.tab === 'agents' || message.tab === 'skills') {
          setActiveTab(message.tab);
        }
        break;
      case 'restoreRun':
        setActiveFlow(message.flow);
        setRunState(message.runState);
        setRunnerVisible(true);
        setActiveStepId(getDefaultActiveStepId(message.flow, message.runState));
        break;
      case 'stepUpdate':
        setRunState(prev => {
          if (!prev) return prev;
          const ps = prev.steps[message.stepId];
          const output = message.append ? `${ps?.output || ''}${message.output || ''}` : (message.output || '');
          return { ...prev, steps: { ...prev.steps, [message.stepId]: { ...ps, output } } };
        });
        break;
      case 'aiReviewUpdate':
        setRunState(prev => {
          if (!prev) return prev;
          const ps = prev.steps[message.stepId];
          const aiReviewOutput = message.append ? `${ps?.aiReviewOutput || ''}${message.output || ''}` : (message.output || '');
          return { ...prev, steps: { ...prev.steps, [message.stepId]: { ...ps, aiReviewOutput } } };
        });
        break;
      case 'runStateChanged':
        setRunState(message.runState);
        if (message.historyEvent && activeFlowRef.current) {
          const flowId = activeFlowRef.current.id;
          const newEvent = { ...message.historyEvent, runId: message.runState.runId };
          setAuditLogs(prev => ({ ...prev, [flowId]: [...(prev[flowId] || []), newEvent] }));
        }
        if (activeFlowRef.current) {
          setActiveStepId(curr => curr ?? getDefaultActiveStepId(activeFlowRef.current!, message.runState));
        }
        break;
      case 'fileImported':
        if (message.kind === 'agent') {
          setAgentForm(prev => ({ ...prev, ...message.item, scope: 'project' }));
          setAgentFormError(null);
          setEditingAgentSource(null);
          setAgentModalOpen(true);
          setActiveTab('agents');
        } else {
          setSkillForm(prev => ({ ...prev, ...message.item, scope: 'project' }));
          setSkillFormError(null);
          setEditingSkillSource(null);
          setSkillModalOpen(true);
          setActiveTab('skills');
        }
        break;
      case 'draftGenerated':
        setDraftLoading(null);
        if (message.error) {
          if (message.kind === 'agent') setAgentFormError(`Draft failed: ${message.error}`);
          else setSkillFormError(`Draft failed: ${message.error}`);
          break;
        }
        if (message.kind === 'agent') {
          setAgentForm(prev => ({ ...prev, systemPrompt: message.content }));
          setAgentFormError(null);
        } else {
          setSkillForm(prev => ({ ...prev, instructions: message.content }));
          setSkillFormError(null);
        }
        break;
      case 'flowGenerated':
        setFlowAiLoading(false);
        if (message.error) {
          setBuilderError(`Flow generation failed: ${message.error}`);
          break;
        }
        if (message.flow) {
          setEditingFlow(message.flow);
          setBuilderError(null);
        }
        if (message.reply) {
          setFlowAiMessages(prev => [...prev, { role: 'assistant', content: message.reply }]);
        }
        break;
    }
  };

  const submitAgentModal = () => {
    if (!agentForm.name.trim()) {
      setAgentFormError('Agent name is required.');
      return;
    }
    setAgentFormError(null);
    if (!isVSCodeWebview()) {
      const agent: Agent = {
        name: agentForm.name.trim(),
        description: agentForm.description || '',
        model: agentForm.model || 'claude-sonnet-4-6',
        tools: agentForm.tools,
        systemPrompt: agentForm.systemPrompt || 'You are a helpful AI agent.',
        sourcePath: `/preview/.claude/agents/${agentForm.name.trim()}.md`
      };
      setAgents(prev => [
        ...prev.filter(item => item.name !== agent.name && item.sourcePath !== editingAgentSource),
        agent
      ]);
      setAgentModalOpen(false);
      setEditingAgentSource(null);
      setAgentForm(emptyAgentForm);
      return;
    }
    sendToVSCode(editingAgentSource ? 'updateAgent' : 'createAgent', {
      agent: {
        name: agentForm.name.trim(),
        description: agentForm.description || '',
        model: agentForm.model || 'claude-sonnet-4-6',
        tools: agentForm.tools,
        systemPrompt: agentForm.systemPrompt || ''
      },
      originalSourcePath: editingAgentSource,
      isGlobal: agentForm.scope === 'global'
    });
    setAgentModalOpen(false);
    setEditingAgentSource(null);
    setAgentForm(emptyAgentForm);
  };

  const openAgentEditor = (agent?: Agent) => {
    if (agent) {
      setAgentForm({
        name: agent.name,
        description: agent.description,
        model: agent.model,
        tools: agent.tools || [],
        systemPrompt: agent.systemPrompt,
        scope: getItemScope(agent.sourcePath)
      });
      setEditingAgentSource(agent.sourcePath);
    } else {
      setAgentForm(emptyAgentForm);
      setEditingAgentSource(null);
    }
    setAgentFormError(null);
    setAgentModalOpen(true);
  };

  const submitSkillModal = () => {
    if (!skillForm.name.trim()) {
      setSkillFormError('Skill name is required.');
      return;
    }
    setSkillFormError(null);
    if (!isVSCodeWebview()) {
      const skill: Skill = {
        name: skillForm.name.trim(),
        description: skillForm.description || '',
        instructions: skillForm.instructions || '',
        sourcePath: `/preview/.claude/skills/${skillForm.name.trim()}`
      };
      setSkills(prev => [
        ...prev.filter(item => item.name !== skill.name && item.sourcePath !== editingSkillSource),
        skill
      ]);
      setSkillModalOpen(false);
      setEditingSkillSource(null);
      setSkillForm(emptySkillForm);
      return;
    }
    sendToVSCode(editingSkillSource ? 'updateSkill' : 'createSkill', {
      skill: {
        name: skillForm.name.trim(),
        description: skillForm.description || '',
        instructions: skillForm.instructions || ''
      },
      originalSourcePath: editingSkillSource,
      isGlobal: skillForm.scope === 'global'
    });
    setSkillModalOpen(false);
    setEditingSkillSource(null);
    setSkillForm(emptySkillForm);
  };

  const openSkillEditor = (skill?: Skill) => {
    if (skill) {
      setSkillForm({
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        scope: getItemScope(skill.sourcePath)
      });
      setEditingSkillSource(skill.sourcePath);
    } else {
      setSkillForm(emptySkillForm);
      setEditingSkillSource(null);
    }
    setSkillFormError(null);
    setSkillModalOpen(true);
  };

  const submitConnectMcp = (config: { name: string; scope: 'global' | 'local'; command: string; args: string[]; env?: Record<string, string> }) => {
    sendToVSCode('connectMcpServer', { config });
    setConnectMcpModalOpen(false);
  };

  const submitRunInputs = () => {
    if (!runInputsTarget) return;
    initRunState(runInputsTarget, runInputValues);
    setRunInputsTarget(null);
    setRunnerVisible(true);
  };

  const runActiveStep = (stepId: string, description?: string) => {
    if (!activeFlow) return;
    const historyEvent = { timestamp: new Date().toISOString(), status: 'running', message: 'Started run' };
    if (!isVSCodeWebview()) {
      seedPreviewRun(stepId, description);
      return;
    }
    sendToVSCode('runStep', { flow: activeFlow, runState, stepId, description, historyEvent });
  };

  const completedSteps = runState ? Object.values(runState.steps).filter(s => s.completionStatus === 'done').length : 0;
  const activeProgress = runState && activeFlow?.steps.length
    ? Math.round((completedSteps / activeFlow.steps.length) * 100)
    : 0;

  const seedPreview = () => {
    setFlows([previewFlow]);
    setAgents(previewAgents);
    setSkills(previewSkills);
    setGlobalPath('/preview/global');
    setProjectPath('/preview/project');
  };

  const seedPreviewRun = (stepId: string, runDescription?: string) => {
    updateRunState(stepId, { 
      executionStatus: 'running',
      output: `Preview mode: simulating Claude output...\n\nRun description:\n${runDescription || 'No run description.'}\n`
    });
    window.setTimeout(() => {
      updateRunState(stepId, () => {
        const step = activeFlowRef.current?.steps.find(s => s.id === stepId);
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
      if (!step.agent || !getAgentByName(step.agent)) return `Step '${label}': agent '${step.agent || '(none)'}' does not exist.`;
      const stepSkills = getStepSkills(step);
      if (stepSkills.length === 0) return `Step '${label}': select at least one skill.`;
      for (const skillName of stepSkills) {
        if (!getSkillByName(skillName)) return `Step '${label}': skill '${skillName}' does not exist.`;
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
    if (!editingFlow) return;
    const error = validateFlow(editingFlow);
    if (error) {
      setBuilderError(error);
      return;
    }
    sendToVSCode('saveFlow', {
      flow: { ...editingFlow, aiConversation: flowAiMessages },
      isGlobal: editingFlowScope === 'global'
    });
    setEditingFlow(null);
    setEditingStep(null);
    setBuilderError(null);
  };

  const saveStepEdit = () => {
    if (!editingStep || !editingFlow) return;
    const newSteps = [...editingFlow.steps];
    const step = editingStep.step;
    const reviewType = step.review.type === 'ai' ? 'ai' : 'human';
    newSteps[editingStep.index] = {
      ...step,
      review: {
        ...step.review,
        required: true,
        type: reviewType,
        reviewers: reviewType === 'ai' ? step.review.reviewers : undefined
      },
      completion: { requireMarkDone: reviewType === 'human' }
    };
    const newFlow = { ...editingFlow, steps: newSteps };

    if (stepEditFromBoard) {
      const error = validateFlow(newFlow);
      if (error) {
        setStepError(error);
        return;
      }
      sendToVSCode('saveFlow', { flow: newFlow, isGlobal: editingFlowScope === 'global' });
      setEditingStep(null);
      setStepError(null);
      setStepEditFromBoard(false);
      setStepIsNew(false);
      setEditingFlow(null);
      return;
    }

    setEditingFlow(newFlow);
    setEditingStep(null);
  };

  return {
    activeTab, setActiveTab,
    flows, setFlows,
    agents, setAgents,
    skills, setSkills,
    bookmarks,
    auditLogs, setAuditLogs,
    globalPath, projectPath, connectedMcpServers,
    activeFlow, setActiveFlow,
    runState, setRunState,
    activeStepId, setActiveStepId,
    runnerVisible, setRunnerVisible,
    commandCopied, setCommandCopied,
    standaloneRun, setStandaloneRun,
    standaloneRunDescription, setStandaloneRunDescription,
    editingFlow, setEditingFlow,
    editingFlowScope, setEditingFlowScope,
    editingStep, setEditingStep,
    stepEditFromBoard, setStepEditFromBoard,
    stepIsNew, setStepIsNew,
    stepError, setStepError,
    builderError, setBuilderError,
    newInputName, setNewInputName,
    flowAiPrompt, setFlowAiPrompt,
    flowAiMessages, setFlowAiMessages,
    flowAiLoading, setFlowAiLoading,
    runInputsTarget, setRunInputsTarget,
    runInputValues, setRunInputValues,
    runInputsError, setRunInputsError,
    detailItem, setDetailItem,
    agentModalOpen, setAgentModalOpen,
    skillModalOpen, setSkillModalOpen,
    connectMcpModalOpen, setConnectMcpModalOpen,
    editingSkillSource, setEditingSkillSource,
    editingAgentSource, setEditingAgentSource,
    agentForm, setAgentForm,
    skillForm, setSkillForm,
    agentFormError, setAgentFormError,
    skillFormError, setSkillFormError,
    draftLoading, setDraftLoading,
    outputEndRef,
    completedSteps, activeProgress,
    handleHostMessage, seedPreview,
    getItemScope, getFlowScope, getAgentByName, getSkillByName,
    isBookmarked, toggleBookmark,
    startOrResumeRun,
    startFreshRun,
    emptyAgentForm, emptySkillForm,
    submitAgentModal, openAgentEditor, submitSkillModal, openSkillEditor,
    submitConnectMcp,
    submitRunInputs, runActiveStep, saveEditingFlow, saveStepEdit
  };
};
