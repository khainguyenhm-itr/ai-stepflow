import { useState } from 'react';
import { Flow, FlowRunState, StepRunState, Agent, Skill, ReviewKit, AdhocRun } from '@claudesteps/core/types';
import { isVSCodeWebview, sendToVSCode } from '../vscode';
import {
  getStepSkills,
  applyDependencyLocks,
  getDefaultActiveStepId,
  hasDependencyCycle
} from '../flowUtils';
import { previewFlow, previewAgents, previewSkills, previewRunState, previewAuditLogs, previewRunSummaries } from '../previewData';

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

  // Per-agent/skill ad-hoc run history (loaded on demand from the host).
  const [historyTarget, setHistoryTarget] = useState<{ kind: 'agent' | 'skill'; name: string } | null>(null);
  const [adhocRuns, setAdhocRuns] = useState<AdhocRun[] | null>(null);
  const openHistory = (kind: 'agent' | 'skill', name: string) => {
    setHistoryTarget({ kind, name });
    setAdhocRuns(null); // null = loading; the host replies with an 'adhocRuns' message.
    sendToVSCode('getAdhocRuns', { kind, name });
  };
  const closeHistory = () => setHistoryTarget(null);

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
        reviewStatus: 'pending',
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
    // Set the focus ref eagerly (the effect only syncs after render) so the first runStateChanged
    // for this new run is recognized as focused and not gated out.
    runState.activeRunIdRef.current = newRunState.runId;
    runState.setActiveStepId(flow.steps[0]?.id || null);
    // Open this run's drawer (single-expand: only one drawer shows at a time).
    runState.setOpenRuns({ [newRunState.runId]: newRunState });
    runState.setOpenStepIds({ [newRunState.runId]: flow.steps[0]?.id || null });
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
    runState.setRunInputsEditing(false);
    runState.setRunInputsTarget(flow);
  };

  /**
   * Open the run-inputs modal in EDIT mode for the active run, prefilled with its current name and
   * inputs. Only meaningful while the run is pristine (the backend re-checks and no-ops otherwise);
   * the FlowBoard menu only surfaces the entry point when no step has started.
   */
  const openRunEditor = (runId: string) => {
    const rs = runState.openRuns[runId];
    const flow = rs ? libState.flows.find((f: Flow) => f.id === rs.flowId) : null;
    if (!flow || !rs) return;
    const inputNames = Object.keys(flow.inputs || {});
    runState.setRunInputValues(Object.fromEntries(inputNames.map(name => [name, (rs.inputs || {})[name] || ''])));
    runState.setRunName(rs.runName || '');
    runState.setRunInputsError(null);
    runState.setRunInputsEditing(true);
    runState.setRunEditRunId(runId);
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
        libState.setReviewKits(message.reviewKits || []);
        libState.setAuditLogs(message.auditLogs || {});
        libState.setRunSummaries(message.runSummaries || []);
        libState.setGlobalPath(message.globalPath);
        libState.setProjectPath(message.projectPath);
        libState.setConnectedMcpServers(message.connectedMcpServers || []);
        libState.setDefaultLibraryInstalled(!!message.defaultLibraryInstalled);
        libState.setRecentWorkspaces(message.recentWorkspaces || []);
        if (message.runTotalsAll) libState.setRunTotalsAll(message.runTotalsAll);
        if (message.runTrendAll) libState.setRunTrendAll(message.runTrendAll);
        if (message.uiPrefs) {
          libState.setScopeFilters({
            flows: parseFilter(message.uiPrefs['scopeFilter:flows']),
            agents: parseFilter(message.uiPrefs['scopeFilter:agents']),
            skills: parseFilter(message.uiPrefs['scopeFilter:skills']),
            reviews: parseFilter(message.uiPrefs['scopeFilter:reviews']),
          });
          libState.setOverviewScope(parseFilter(message.uiPrefs['overviewScope']));
          const parseViewFilter = (v: unknown): ViewFilter => {
            if (Array.isArray(v)) return (v as string[]).filter((x): x is ViewFilterItem => x === 'built-in');
            if (v === 'built-in') return [v]; // migrate old persisted string
            return [];
          };
          const parseSortOrder = (v: string | undefined): SortOrder =>
            v === 'desc' || v === 'asc' || v === 'newest' || v === 'oldest' ? v : 'activity';
          libState.setViewFilters({
            flows: parseViewFilter(message.uiPrefs['viewFilter:flows']),
            agents: parseViewFilter(message.uiPrefs['viewFilter:agents']),
            skills: parseViewFilter(message.uiPrefs['viewFilter:skills']),
            reviews: parseViewFilter(message.uiPrefs['viewFilter:reviews']),
          });
          libState.setSortOrders({
            flows: parseSortOrder(message.uiPrefs['sortOrder:flows']),
            agents: parseSortOrder(message.uiPrefs['sortOrder:agents']),
            skills: parseSortOrder(message.uiPrefs['sortOrder:skills']),
            reviews: parseSortOrder(message.uiPrefs['sortOrder:reviews']),
          });
          const parseGroupBy = (v: string | undefined): 'list' | 'tag' => (v === 'tag' ? 'tag' : 'list');
          libState.setGroupBys({
            agents: parseGroupBy(message.uiPrefs['groupBy:agents']),
            skills: parseGroupBy(message.uiPrefs['groupBy:skills']),
            reviews: parseGroupBy(message.uiPrefs['groupBy:reviews']),
          });
          const savedTab = message.uiPrefs['activeTab'];
          if (savedTab === 'overview' || savedTab === 'flows' || savedTab === 'agents' || savedTab === 'skills' || savedTab === 'reviews') {
            libState.setActiveTab(savedTab);
          }

        }
        break;
      case 'mcpServers':
        libState.setConnectedMcpServers(message.connectedMcpServers || []);
        break;
      case 'navigateToTab':
        if (message.tab === 'overview' || message.tab === 'flows' || message.tab === 'agents' || message.tab === 'skills' || message.tab === 'reviews') {
          libState.setActiveTab(message.tab);
        }
        break;
      case 'revealRun':
        runState.setRevealRun(prev => ({ flowId: message.flowId, runId: message.runId, nonce: (prev?.nonce ?? 0) + 1 }));
        break;
      case 'restoreRun':
        // A reset mints a new runId; remap the old summary row to it (progress cleared) so the row
        // matches the restored run and its detail drawer stays openable.
        if (message.previousRunId) {
          const prevRunId = message.previousRunId;
          const next = message.runState;
          libState.setRunSummaries(prev => prev.map(s =>
            s.flowId === next.flowId && s.runId === prevRunId
              ? { flowId: s.flowId, runId: next.runId, runName: next.runName, completedSteps: 0, totalSteps: s.totalSteps, mtimeMs: Date.now(), isClosed: false }
              : s
          ));
          // Reset mints a new runId — move the open drawer from the old runId to the new one.
          runState.setOpenRuns(prev => { const { [prevRunId]: _drop, ...rest } = prev; return rest; });
          runState.setOpenStepIds(prev => { const { [prevRunId]: _drop, ...rest } = prev; return rest; });
        }
        runState.setActiveFlow(message.flow);
        runState.setRunState(message.runState);
        // Eagerly focus this run (see initRunState) so its stream isn't gated out before the effect syncs.
        runState.activeRunIdRef.current = message.runState.runId;
        runState.setRunnerVisible(true);
        runState.setActiveStepId(getDefaultActiveStepId(message.flow, message.runState));
        // Open this run's drawer (single-expand: replace any other open drawer, keep this run's step).
        runState.setOpenRuns({ [message.runState.runId]: message.runState });
        runState.setOpenStepIds(prev => ({ [message.runState.runId]: prev[message.runState.runId] ?? getDefaultActiveStepId(message.flow, message.runState) }));
        break;
      case 'runDeleted': {
        const { flowId, runId } = message;
        libState.setRunSummaries(prev => prev.filter(s => !(s.flowId === flowId && s.runId === runId)));
        libState.setAuditLogs(prev => {
          if (!prev[flowId]) return prev;
          const filtered = prev[flowId].filter((e: any) => e.runId !== runId);
          return { ...prev, [flowId]: filtered };
        });
        // Close this run's drawer.
        runState.setOpenRuns(prev => { const { [runId]: _drop, ...rest } = prev; return rest; });
        runState.setOpenStepIds(prev => { const { [runId]: _drop, ...rest } = prev; return rest; });
        // Only clear the focused facade if the deleted run was the focused one.
        if (!runId || runState.activeRunIdRef.current === runId) {
          runState.setRunState(null);
          runState.setActiveFlow(null);
          runState.setActiveStepId(null);
          runState.setRunnerVisible(false);
        }
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
        // Close this run's drawer (if the message carried a runId).
        if (message.runId) {
          const cid = message.runId;
          runState.setOpenRuns(prev => { const { [cid]: _drop, ...rest } = prev; return rest; });
          runState.setOpenStepIds(prev => { const { [cid]: _drop, ...rest } = prev; return rest; });
        }
        // Only clear the focused facade if the closed run was the focused one (or legacy: no runId).
        if (!message.runId || runState.activeRunIdRef.current === message.runId) {
          runState.setRunState(null);
          runState.setActiveFlow(null);
          runState.setActiveStepId(null);
          runState.setRunnerVisible(false);
        }
        break;
      case 'resetAuditLog':
        runState.setRunState(currentRun => {
          if (currentRun) {
            // Targeted per-step reset carries runId + stepIds; a full run reset carries neither
            // and clears every entry for the current run.
            const runId = message.runId ?? currentRun.runId;
            const stepIds = message.stepIds ? new Set(message.stepIds) : null;
            libState.setAuditLogs(prev => {
              const flowId = message.flowId;
              if (!prev[flowId]) return prev;
              return {
                ...prev,
                [flowId]: prev[flowId].filter(e =>
                  e.runId !== runId ? true : stepIds ? !stepIds.has(e.stepId) : false
                )
              };
            });
          }
          return currentRun;
        });
        break;
      case 'stepUpdate': {
        // Route to the drawer that owns this run. Each open drawer renders from its own openRuns
        // entry, so a background run's stream lands on ITS drawer, never the focused one.
        const rid = message.runId ?? runState.activeRunIdRef.current;
        if (!rid) break;
        runState.setOpenRuns(prev => {
          const rs = prev[rid];
          if (!rs) return prev; // drawer not open — output is shown from persisted state on open
          const ps = rs.steps[message.stepId];
          const output = message.append ? `${ps?.output || ''}${message.output || ''}` : (message.output || '');
          return { ...prev, [rid]: { ...rs, steps: { ...rs.steps, [message.stepId]: { ...ps, output } } } };
        });
        break;
      }
      case 'aiReviewUpdate': {
        const rid = message.runId ?? runState.activeRunIdRef.current;
        if (!rid) break;
        runState.setOpenRuns(prev => {
          const rs = prev[rid];
          if (!rs) return prev;
          const ps = rs.steps[message.stepId];
          const aiReviewOutput = message.append ? `${ps?.aiReviewOutput || ''}${message.output || ''}` : (message.output || '');
          return { ...prev, [rid]: { ...rs, steps: { ...rs.steps, [message.stepId]: { ...ps, aiReviewOutput } } } };
        });
        break;
      }
      case 'runStateChanged': {
        const changed = message.runState;
        // Only the focused run drives the open runner view; a background (concurrent) run's state is
        // persisted server-side and loaded fresh when the user switches to it. The summary-row and
        // audit updates below still run for ANY run (matched by id), so background runs stay live in
        // the runs table without corrupting the focused view.
        const isFocused = runState.activeRunIdRef.current === changed.runId;
        if (isFocused) runState.setRunState(changed);
        // Refresh the changed run's OPEN drawer (works for any open run, not only the focused one).
        runState.setOpenRuns(prev => prev[changed.runId] ? { ...prev, [changed.runId]: changed } : prev);
        // Advance that drawer's selected step when its current step just finished.
        const changedFlow = libState.flows.find((f: Flow) => f.id === changed.flowId) ?? runState.activeFlowRef.current;
        if (changedFlow) {
          runState.setOpenStepIds(prev => {
            if (!(changed.runId in prev)) return prev;
            const curr = prev[changed.runId];
            if (!curr || changed.steps[curr]?.completionStatus === 'done') {
              return { ...prev, [changed.runId]: getDefaultActiveStepId(changedFlow, changed) };
            }
            return prev;
          });
        }
        // Keep the outer run table row in sync with the live run — otherwise steps/cost/tokens
        // only refresh on a full reload, so the detail drawer updates but the table lags behind.
        const steps = Object.values(changed.steps || {}) as any[];
        const span = (from?: string, to?: string) => {
          if (!from || !to) return 0;
          const ms = new Date(to).getTime() - new Date(from).getTime();
          return Number.isFinite(ms) && ms > 0 ? ms : 0;
        };
        const isReviewing = (s: any) => s.reviewStatus === 'ai_review_running' || s.reviewStatus === 'waiting_human';
        const agg = {
          completedSteps: steps.filter(s => s.completionStatus === 'done').length,
          // Steps that have started but aren't done yet (running or under review) — counted toward
          // the table's "N/total" so a step in flight shows its own position (e.g. 2/5), and used
          // to flag the run as under review (yellow) rather than plain running (blue).
          inProgressSteps: steps.filter(s => s.executionStatus === 'running' || isReviewing(s)).length,
          reviewing: steps.some(isReviewing),
          failedSteps: steps.filter(s => s.executionStatus === 'failed').length,
          totalSteps: steps.length,
          costUsd: steps.reduce((t, s) => t + (s.costUsd ?? 0), 0),
          tokensUsed: steps.reduce((t, s) => t + (s.tokensUsed ?? 0), 0),
          taskTimeMs: steps.reduce((t, s) => t + span(s.startedAt, s.completedAt), 0),
          reviewTimeMs: steps.reduce((t, s) => t + span(s.completedAt, s.reviewCompletedAt), 0)
        };
        libState.setRunSummaries(prev => prev.map(s =>
          s.flowId === changed.flowId && s.runId === changed.runId
            ? { ...s, ...agg, runName: changed.runName, isClosed: !!changed.isClosed, mtimeMs: Date.now() }
            : s
        ));
        if (message.historyEvent) {
          // The event belongs to the CHANGED run's flow, which may differ from the focused flow.
          const flowId = changed.flowId;
          const newEvent = { ...message.historyEvent, runId: changed.runId };
          libState.setAuditLogs(prev => ({ ...prev, [flowId]: [...(prev[flowId] || []), newEvent] }));
        }
        if (isFocused && runState.activeFlowRef.current) {
          const flow = runState.activeFlowRef.current;
          runState.setActiveStepId(curr => {
            // No step selected yet → pick the default.
            if (!curr) return getDefaultActiveStepId(flow, message.runState);
            // Active step just finished → auto-advance to the next unfinished step.
            if (message.runState.steps[curr]?.completionStatus === 'done') {
              return getDefaultActiveStepId(flow, message.runState);
            }
            return curr;
          });
        }
        break;
      }
      case 'fileImported':
        if (message.kind === 'agent') {
          buildState.setAgentForm(prev => ({ ...prev, ...message.item, scope: 'project' }));
          buildState.setAgentFormError(null);
          buildState.setEditingAgentSource(null);
          buildState.setAgentModalOpen(true);
          libState.setActiveTab('agents');
        } else if (message.kind === 'review') {
          buildState.setReviewForm(prev => ({ ...prev, ...message.item, scope: 'project' }));
          buildState.setReviewFormError(null);
          buildState.setEditingReviewSource(null);
          buildState.setReviewModalOpen(true);
          libState.setActiveTab('reviews');
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
      case 'adhocRuns':
        setAdhocRuns(message.runs || []);
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

  const submitReviewModal = () => {
    if (!buildState.reviewForm.name.trim()) {
      buildState.setReviewFormError('Review name is required.');
      return;
    }
    buildState.setReviewFormError(null);
    if (!isVSCodeWebview()) {
      const review: ReviewKit = {
        name: buildState.reviewForm.name.trim(),
        description: buildState.reviewForm.description || '',
        content: buildState.reviewForm.content || '',
        sourcePath: `/preview/.claude/reviews/${buildState.reviewForm.name.trim()}`
      };
      libState.setReviewKits(prev => [
        ...prev.filter(item => item.name !== review.name && item.sourcePath !== buildState.editingReviewSource),
        review
      ]);
      buildState.setReviewModalOpen(false);
      buildState.setEditingReviewSource(null);
      buildState.setReviewForm(buildState.emptyReviewForm);
      return;
    }
    sendToVSCode(buildState.editingReviewSource ? 'updateReviewKit' : 'createReviewKit', {
      review: {
        name: buildState.reviewForm.name.trim(),
        description: buildState.reviewForm.description || '',
        content: buildState.reviewForm.content || ''
      },
      originalSourcePath: buildState.editingReviewSource,
      isGlobal: buildState.reviewForm.scope === 'global'
    });
    buildState.setReviewModalOpen(false);
    buildState.setEditingReviewSource(null);
    buildState.setReviewForm(buildState.emptyReviewForm);
  };

  const openReviewEditor = (review?: ReviewKit, newScope: SaveScope = 'project') => {
    if (review) {
      buildState.setReviewForm({
        name: review.name,
        description: review.description,
        content: review.content,
        scope: libState.getItemScope(review.sourcePath)
      });
      buildState.setEditingReviewSource(review.sourcePath);
    } else {
      buildState.setReviewForm({ ...buildState.emptyReviewForm, scope: newScope });
      buildState.setEditingReviewSource(null);
    }
    buildState.setReviewFormError(null);
    buildState.setReviewModalOpen(true);
  };

  const submitConnectMcp = (config: { name: string; scope: 'global' | 'local'; command: string; args: string[]; env?: Record<string, string> }) => {
    sendToVSCode('connectMcpServer', { config });
    buildState.setConnectMcpModalOpen(false);
  };

  const submitRunInputs = () => {
    if (!runState.runInputsTarget) return;
    if (runState.runInputsEditing) {
      // Edit mode: patch the targeted run's name + inputs in place (backend enforces the pristine gate).
      sendToVSCode('editRun', { runName: runState.runName.trim() || undefined, inputs: runState.runInputValues, runId: runState.runEditRunId ?? undefined });
      runState.setRunInputsTarget(null);
      runState.setRunInputsEditing(false);
      runState.setRunEditRunId(null);
      return;
    }
    initRunState(runState.runInputsTarget, runState.runName.trim() || undefined, runState.runInputValues);
    runState.setRunInputsTarget(null);
    runState.setRunnerVisible(true);
  };

  /** Run a step for a specific open run (multi-drawer): resolves the run + its flow by runId. */
  const runActiveStep = (runId: string, stepId: string, description?: string) => {
    const rs = runState.openRuns[runId];
    const flow = rs ? libState.flows.find((f: Flow) => f.id === rs.flowId) ?? runState.activeFlow : runState.activeFlow;
    if (!flow || !rs) return;
    const historyEvent = { timestamp: new Date().toISOString(), status: 'running', message: 'Started run' };
    if (!isVSCodeWebview()) {
      seedPreviewRun(stepId, description);
      return;
    }
    sendToVSCode('runStep', { flow, runState: rs, stepId, description, runId, historyEvent });
  };

  /** Select a step within one open run's drawer. */
  const setOpenStepId = (runId: string, id: string) => {
    runState.setOpenStepIds(prev => ({ ...prev, [runId]: id }));
  };

  /**
   * Collapse a run's drawer — a LOCAL UI action only. It must NOT tell the backend to close/forget
   * the run (the run may still be executing in its own terminal); the backend RunCtx stays alive and
   * the run can be reopened later via switchRun.
   */
  const collapseRun = (runId: string) => {
    runState.setOpenRuns(prev => { const { [runId]: _drop, ...rest } = prev; return rest; });
    runState.setOpenStepIds(prev => { const { [runId]: _drop, ...rest } = prev; return rest; });
    if (runState.activeRunIdRef.current === runId) {
      runState.activeRunIdRef.current = null;
      runState.setRunState(null);
      runState.setRunnerVisible(false);
    }
  };

  const seedPreview = () => {
    libState.setFlows([previewFlow]);
    libState.setAgents(previewAgents);
    libState.setSkills(previewSkills);
    libState.setGlobalPath('/preview/global');
    libState.setProjectPath('/preview/project');
    // Open straight into the finished sample run so the runner sub-tabs (Console / Files /
    // Cost / History) have real content to inspect without a VS Code host.
    libState.setAuditLogs(previewAuditLogs);
    libState.setRunSummaries(previewRunSummaries);
    runState.setActiveFlow(previewFlow);
    runState.setRunState(previewRunState);
    runState.setActiveStepId('write-docs');
    runState.setRunnerVisible(true);
  };

  const seedPreviewRun = (stepId: string, runDescription?: string) => {
    updateRunState(stepId, { 
      executionStatus: 'running',
      output: `Preview mode: simulating Claude output...\n\nRun description:\n${runDescription || 'No run description.'}\n`
    });
    window.setTimeout(() => {
      updateRunState(stepId, () => ({
        executionStatus: 'completed',
        output: 'Preview mode: simulated step completed successfully.\n\nInstall the VSIX or run the extension host to execute Claude for real.'
      }));
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
      }
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
    historyTarget, adhocRuns, openHistory, closeHistory,
    handleHostMessage, seedPreview,
    startOrResumeRun,
    startFreshRun,
    submitAgentModal, openAgentEditor, submitSkillModal, openSkillEditor,
    submitReviewModal, openReviewEditor,
    submitConnectMcp,
    submitRunInputs, openRunEditor, runActiveStep, setOpenStepId, collapseRun, saveEditingFlow, saveStepEdit
  };
};
