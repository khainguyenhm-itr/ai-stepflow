import React from 'react';
import { Flow, FlowStep, } from '@claudesteps/core/types';
import './App.css';
import { isVSCodeWebview, sendToVSCode } from './vscode';
import { getStepSkills } from './flowUtils';
import { useVsCodeBridge } from './hooks/useVsCodeBridge';
import { useAppLogic } from './hooks/useAppLogic';

import { OverviewTab } from './tabs/OverviewTab';
import { FlowsTab } from './tabs/FlowsTab';
import { AgentsTab } from './tabs/AgentsTab';
import { SkillsTab } from './tabs/SkillsTab';
import { ReviewsTab } from './tabs/ReviewsTab';
import { DetailModal } from './modals/DetailModal';
import { AgentModal } from './modals/AgentModal';
import { SkillModal } from './modals/SkillModal';
import { ReviewModal } from './modals/ReviewModal';
import { ConnectMcpModal } from './modals/ConnectMcpModal';
import { RunInputsModal } from './modals/RunInputsModal';
import { FlowBuilderModal } from './modals/FlowBuilderModal';
import { StepModal } from './modals/StepModal';
import { StandaloneRunModal } from './modals/StandaloneRunModal';
import { HistoryModal } from './modals/HistoryModal';
import { ConfirmDialog } from './components/primitives';

const App: React.FC = () => {
  const logic = useAppLogic();
  const {
    activeTab, setActiveTab,
    flows, agents, skills, reviewKits, auditLogs, runSummaries,
    globalPath, projectPath, connectedMcpServers, defaultLibraryInstalled,
    recentWorkspaces, overviewScope, setOverviewScope, runTotalsAll, runTrendAll,
    activeFlow,
    runState,
    activeStepId, setActiveStepId,
    runnerVisible,
    revealRun,
    openRuns, openStepIds, setOpenStepId,
    commandCopied, setCommandCopied,
    standaloneRun, setStandaloneRun,
    standaloneRunDescription, setStandaloneRunDescription,
    historyTarget, adhocRuns, openHistory, closeHistory,
    editingFlow, setEditingFlow,
    editingFlowScope, setEditingFlowScope,
    editingStep, setEditingStep,
    stepEditFromBoard, setStepEditFromBoard,
    stepIsNew, setStepIsNew,
    stepError,
    builderError, setBuilderError,
    newInputName, setNewInputName,
    flowAiPrompt, setFlowAiPrompt,
    flowAiMessages, setFlowAiMessages,
    flowAiLoading, setFlowAiLoading,
    runInputsTarget, setRunInputsTarget,
    runInputsEditing, setRunInputsEditing,
    runName, setRunName,
    runInputValues, setRunInputValues,
    runInputsError,
    detailItem, setDetailItem,
    agentModalOpen, setAgentModalOpen,
    skillModalOpen, setSkillModalOpen,
    reviewModalOpen, setReviewModalOpen,
    connectMcpModalOpen, setConnectMcpModalOpen,
    editingSkillSource, setEditingSkillSource,
    editingAgentSource, setEditingAgentSource,
    editingReviewSource, setEditingReviewSource,
    agentForm, setAgentForm,
    skillForm, setSkillForm,
    reviewForm, setReviewForm,
    scopeFilters,
    viewFilters,
    sortOrders,
    groupBys, setGroupBys,
    agentFormError, setAgentFormError,
    skillFormError, setSkillFormError,
    reviewFormError,
    draftLoading, setDraftLoading,
    agentAiPrompt, setAgentAiPrompt,
    agentAiMessages, setAgentAiMessages,
    skillAiPrompt, setSkillAiPrompt,
    skillAiMessages, setSkillAiMessages,
    outputEndRef,
    completedSteps, activeProgress,
    handleHostMessage, seedPreview,
    getItemScope, getFlowScope, getAgentByName, getSkillByName,
    startFreshRun,
    submitAgentModal, openAgentEditor, submitSkillModal, openSkillEditor,
    submitReviewModal, openReviewEditor,
    submitConnectMcp,
    submitRunInputs, openRunEditor, runActiveStep, collapseRun, saveEditingFlow, saveStepEdit
  } = logic;

  useVsCodeBridge(handleHostMessage, seedPreview);

  // Closing an AI-generate modal mid-generation is gated by a confirm popup that,
  // on confirm, cancels all related generation processes on the host.
  const [pendingCancelGen, setPendingCancelGen] = React.useState<null | 'agent' | 'skill' | 'flow'>(null);
  const closeAgentModal = () => { setAgentModalOpen(false); setEditingAgentSource(null); };
  const closeSkillModal = () => { setSkillModalOpen(false); setEditingSkillSource(null); };
  const closeFlowModal = () => setEditingFlow(null);
  const requestClose = (which: 'agent' | 'skill' | 'flow', close: () => void) => () => {
    const generating = which === 'flow' ? flowAiLoading : draftLoading === which;
    if (generating) setPendingCancelGen(which);
    else close();
  };

  // Suggest a run name as `<workflow-slug>-<n>`, where n is the next number after the
  // highest existing `<slug>-N` run for this flow, so repeated clicks never collide.
  const generateRunName = () => {
    if (!runInputsTarget) return;
    const base = runInputsTarget.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
    const re = new RegExp(`^${base}-(\\d+)$`);
    const max = runSummaries
      .filter(s => s.flowId === runInputsTarget.id)
      .reduce((m, s) => { const mt = s.runName?.match(re); return mt ? Math.max(m, parseInt(mt[1], 10)) : m; }, 0);
    setRunName(`${base}-${max + 1}`);
  };

  const getScope = (sourcePath: string) => {
    if (globalPath && sourcePath.startsWith(globalPath)) return 'Global';
    if (projectPath && sourcePath.startsWith(projectPath)) return 'Current repo';
    return sourcePath.includes('/preview/') ? 'Preview' : 'Current repo';
  };

  const renderScopeBadge = (sourcePath: string) => {
    const scope = getItemScope(sourcePath);
    return <span className="badge scope">{scope === 'global' ? 'global' : 'repo'}</span>;
  };

  const tabs: { key: typeof activeTab; label: string; count?: number }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'flows', label: 'Workflows', count: flows.length },
    { key: 'agents', label: 'Agents', count: agents.length },
    { key: 'skills', label: 'Skills', count: skills.length },
    { key: 'reviews', label: 'Reviews', count: reviewKits.length }
  ];

  return (
    <div className="app">
      <nav className="tab-bar">
        {tabs.map(tab => (
          <button
            key={tab.key}
            className={`tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => { setActiveTab(tab.key); sendToVSCode('savePref', { key: 'activeTab', value: tab.key }); }}
          >
            {tab.label}
            {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
          </button>
        ))}
      </nav>

      {activeTab === 'overview' && (
        <OverviewTab
          flows={flows}
          agents={agents}
          skills={skills}
          runSummaries={runSummaries}
          connectedMcpServers={connectedMcpServers}
          defaultLibraryInstalled={defaultLibraryInstalled}
          recentWorkspaces={recentWorkspaces}
          runTotalsAll={runTotalsAll}
          runTrendAll={runTrendAll}
          globalPath={globalPath}
          projectPath={projectPath}
          scope={overviewScope}
          onScopeChange={v => { setOverviewScope(v); sendToVSCode('savePref', { key: 'overviewScope', value: v, global: true }); }}
          onNavigate={tab => { setActiveTab(tab); sendToVSCode('savePref', { key: 'activeTab', value: tab }); }}
          onConnectMcp={() => setConnectMcpModalOpen(true)}
          onRunCommand={command => sendToVSCode('runCommand', { command })}
          onOpenWorkspace={path => sendToVSCode('openWorkspace', { path })}
          onRevealPath={path => sendToVSCode('revealPath', { path })}
          onConnectGitnexus={() => sendToVSCode('connectGitnexus', {})}
        />
      )}

      {activeTab === 'flows' && (
        <FlowsTab
          flows={flows}
          agents={agents}
          skills={skills}
          auditLogs={auditLogs}
          runSummaries={runSummaries}
          revealRun={revealRun}
          openRuns={openRuns}
          openStepIds={openStepIds}
          commandCopied={commandCopied}
          globalPath={globalPath}
          projectPath={projectPath}
          onRun={startFreshRun}
          onEditRun={openRunEditor}
          onEdit={flow => {
            setEditingFlow(JSON.parse(JSON.stringify(flow)));
            setEditingFlowScope(getFlowScope(flow));
            setBuilderError(null);
            setNewInputName('');
            setFlowAiPrompt('');
            setFlowAiMessages(flow.aiConversation || []);
          }}
          onClone={flow => {
            const clone: Flow = JSON.parse(JSON.stringify(flow));
            clone.id = `flow-${Date.now()}`;
            clone.name = `${flow.name} (copy)`;
            clone.sourcePath = '';
            setEditingFlow(clone);
            setEditingFlowScope(getFlowScope(flow));
            setBuilderError(null);
            setNewInputName('');
            setFlowAiPrompt('');
            setFlowAiMessages(clone.aiConversation || []);
          }}
          onDetail={flow => setDetailItem({
            type: 'Flow',
            title: flow.name,
            description: flow.description,
            sourcePath: flow.sourcePath,
            meta: { Scope: getScope(flow.sourcePath), Steps: flow.steps.length, Inputs: Object.keys(flow.inputs || {}).length, Trust: flow.trustLevel || 'trusted' },
            onDelete: () => sendToVSCode('deleteFlow', { flow })
          })}
          onNew={(flow, scope) => {
            setEditingFlow(flow);
            setEditingFlowScope(scope);
            setBuilderError(null);
            setNewInputName('');
            setFlowAiPrompt('');
            setFlowAiMessages(flow.aiConversation || []);
          }}
          onBoardStepEditor={(flow, index) => {
            const step = flow.steps[index];
            if (!step) return;
            setEditingFlow(JSON.parse(JSON.stringify(flow)));
            setEditingStep({ step: JSON.parse(JSON.stringify(step)), index });
            setEditingFlowScope(getFlowScope(flow));
            setStepEditFromBoard(true);
            setStepIsNew(false);
          }}
          onBoardStepAdder={flow => {
            const previous = flow.steps[flow.steps.length - 1];
            const newStep: FlowStep = {
              id: `step-${Date.now()}`,
              title: '',
              agent: '',
              skill: '',
              dependsOn: previous ? [previous.id] : [],
              review: { required: true, type: 'ai' }
            };
            setEditingFlow(JSON.parse(JSON.stringify(flow)));
            setEditingStep({ step: newStep, index: flow.steps.length });
            setEditingFlowScope(getFlowScope(flow));
            setStepEditFromBoard(true);
            setStepIsNew(true);
          }}
          onRemoveStep={(flow, index) => {
            const removed = flow.steps[index];
            const newSteps = [...flow.steps];
            newSteps.splice(index, 1);
            const newFlow = {
              ...flow,
              steps: newSteps.map(step => ({
                ...step,
                dependsOn: (step.dependsOn || []).filter(id => id !== removed?.id)
              }))
            };
            sendToVSCode('saveFlow', { flow: newFlow, isGlobal: getFlowScope(flow) === 'global' });
          }}
          onSetActiveStep={setOpenStepId}
          onRunStep={runActiveStep}
          onCollapseRun={collapseRun}
          onOpenFile={path => sendToVSCode('openFile', { path })}
          onCopyCommand={() => {
            const step = activeFlow?.steps.find((s: FlowStep) => s.id === activeStepId);
            if (!step) return;
            const skills = getStepSkills(step);
            const cmd = skills.map(s => `/${s}`).join(' ');
            navigator.clipboard.writeText(cmd);
            setCommandCopied(true);
            window.setTimeout(() => setCommandCopied(false), 1200);
          }}
          initialFilter={scopeFilters.flows}
          onScopeFilterChange={v => sendToVSCode('savePref', { key: 'scopeFilter:flows', value: v })}
          initialViewFilter={viewFilters.flows}
          onViewFilterChange={v => sendToVSCode('savePref', { key: 'viewFilter:flows', value: v })}
          initialSortOrder={sortOrders.flows}
          onSortOrderChange={v => sendToVSCode('savePref', { key: 'sortOrder:flows', value: v })}
        />
      )}

      {activeTab === 'agents' && (
        <AgentsTab
          agents={agents}
          globalPath={globalPath}
          projectPath={projectPath}
          initialFilter={scopeFilters.agents}
          onScopeFilterChange={v => sendToVSCode('savePref', { key: 'scopeFilter:agents', value: v })}
          initialViewFilter={viewFilters.agents}
          onViewFilterChange={v => sendToVSCode('savePref', { key: 'viewFilter:agents', value: v })}
          initialSortOrder={sortOrders.agents}
          onSortOrderChange={v => sendToVSCode('savePref', { key: 'sortOrder:agents', value: v })}
          initialGroupBy={groupBys.agents}
          onGroupByChange={v => { setGroupBys(p => ({ ...p, agents: v })); sendToVSCode('savePref', { key: 'groupBy:agents', value: v, global: true }); }}
          onOpenEditor={openAgentEditor}
          onRun={agent => {
            setStandaloneRun({ type: 'agent', agent });
            setStandaloneRunDescription('');
          }}
          onHistory={agent => openHistory('agent', agent.name)}
          onDetail={agent => setDetailItem({
            type: 'Agent',
            title: agent.name,
            description: agent.description,
            sourcePath: agent.sourcePath,
            meta: { Scope: getScope(agent.sourcePath), Model: agent.model },
            onDelete: () => sendToVSCode('deleteAgent', { agent })
          })}
          onNew={scope => openAgentEditor({ name: '', description: '', model: 'sonnet', tools: [], systemPrompt: '', sourcePath: scope === 'global' ? globalPath : projectPath })}
        />
      )}

      {activeTab === 'skills' && (
        <SkillsTab
          skills={skills}
          globalPath={globalPath}
          projectPath={projectPath}
          initialFilter={scopeFilters.skills}
          onScopeFilterChange={v => sendToVSCode('savePref', { key: 'scopeFilter:skills', value: v })}
          initialViewFilter={viewFilters.skills}
          onViewFilterChange={v => sendToVSCode('savePref', { key: 'viewFilter:skills', value: v })}
          initialSortOrder={sortOrders.skills}
          onSortOrderChange={v => sendToVSCode('savePref', { key: 'sortOrder:skills', value: v })}
          initialGroupBy={groupBys.skills}
          onGroupByChange={v => { setGroupBys(p => ({ ...p, skills: v })); sendToVSCode('savePref', { key: 'groupBy:skills', value: v, global: true }); }}
          onOpenEditor={openSkillEditor}
          onRun={skill => {
            setStandaloneRun({ type: 'skill', skill });
            setStandaloneRunDescription('');
          }}
          onHistory={skill => openHistory('skill', skill.name)}
          onDetail={skill => setDetailItem({
            type: 'Skill',
            title: skill.name,
            description: skill.description,
            sourcePath: skill.sourcePath,
            meta: { Scope: getScope(skill.sourcePath) },
            onDelete: () => sendToVSCode('deleteSkill', { skill })
          })}
          onNew={scope => openSkillEditor(undefined, scope)}
        />
      )}

      {activeTab === 'reviews' && (
        <ReviewsTab
          reviewKits={reviewKits}
          globalPath={globalPath}
          initialFilter={scopeFilters.reviews}
          onScopeFilterChange={v => sendToVSCode('savePref', { key: 'scopeFilter:reviews', value: v })}
          initialViewFilter={viewFilters.reviews}
          onViewFilterChange={v => sendToVSCode('savePref', { key: 'viewFilter:reviews', value: v })}
          initialSortOrder={sortOrders.reviews}
          onSortOrderChange={v => sendToVSCode('savePref', { key: 'sortOrder:reviews', value: v })}
          onOpenEditor={openReviewEditor}
          onDetail={kit => setDetailItem({
            type: 'Review',
            title: kit.name,
            description: kit.description,
            sourcePath: kit.sourcePath,
            meta: { Scope: getScope(kit.sourcePath) },
            onDelete: () => sendToVSCode('deleteReviewKit', { review: kit })
          })}
          onNew={scope => openReviewEditor(undefined, scope)}
          onInstallDefault={() => sendToVSCode('installReviewDefault', { isGlobal: scopeFilters.reviews === 'global' })}
        />
      )}

      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} onOpenFile={path => sendToVSCode('openFile', { path })} />

      <AgentModal
        open={agentModalOpen}
        editingSource={editingAgentSource}
        form={agentForm}
        error={agentFormError}
        draftLoading={draftLoading === 'agent'}
        connectedMcpServers={connectedMcpServers}
        aiPrompt={agentAiPrompt}
        aiMessages={agentAiMessages}
        onClose={requestClose('agent', closeAgentModal)}
        onConnectMcp={() => setConnectMcpModalOpen(true)}
        onChange={patch => setAgentForm(prev => ({ ...prev, ...patch }))}
        onSubmit={submitAgentModal}
        onAiPromptChange={setAgentAiPrompt}
        onGenerateAgent={() => {
          if (!agentAiPrompt.trim() || draftLoading) return;
          const prompt = agentAiPrompt.trim();
          const prevMessages = agentAiMessages;
          setAgentAiMessages([...prevMessages, { role: 'user', content: prompt }]);
          setAgentAiPrompt('');
          setDraftLoading('agent');
          setAgentFormError(null);
          if (!isVSCodeWebview()) {
            window.setTimeout(() => {
              setAgentForm(prev => ({ ...prev, name: prev.name || 'ai-agent', description: 'AI-generated agent', systemPrompt: `You are an AI agent. ${prompt}` }));
              setAgentAiMessages(prev => [...prev, { role: 'assistant', content: 'Agent generated — see below.' }]);
              setDraftLoading(null);
            }, 800);
            return;
          }
          sendToVSCode('generateDraft', { kind: 'agent', prompt, history: prevMessages });
        }}
      />

      <SkillModal
        open={skillModalOpen}
        editingSource={editingSkillSource}
        form={skillForm}
        error={skillFormError}
        draftLoading={draftLoading === 'skill'}
        aiPrompt={skillAiPrompt}
        aiMessages={skillAiMessages}
        onClose={requestClose('skill', closeSkillModal)}
        onChange={patch => setSkillForm(prev => ({ ...prev, ...patch }))}
        onSubmit={submitSkillModal}
        onAiPromptChange={setSkillAiPrompt}
        onGenerateSkill={() => {
          if (!skillAiPrompt.trim() || draftLoading) return;
          const prompt = skillAiPrompt.trim();
          const prevMessages = skillAiMessages;
          setSkillAiMessages([...prevMessages, { role: 'user', content: prompt }]);
          setSkillAiPrompt('');
          setDraftLoading('skill');
          setSkillFormError(null);
          if (!isVSCodeWebview()) {
            window.setTimeout(() => {
              setSkillForm(prev => ({ ...prev, name: prev.name || 'ai-skill', description: 'AI-generated skill', instructions: `# Skill\n\n${prompt}` }));
              setSkillAiMessages(prev => [...prev, { role: 'assistant', content: 'Skill generated — see below.' }]);
              setDraftLoading(null);
            }, 800);
            return;
          }
          sendToVSCode('generateDraft', { kind: 'skill', prompt, history: prevMessages });
        }}
      />

      <ReviewModal
        open={reviewModalOpen}
        editingSource={editingReviewSource}
        form={reviewForm}
        error={reviewFormError}
        onClose={() => { setReviewModalOpen(false); setEditingReviewSource(null); }}
        onChange={patch => setReviewForm(prev => ({ ...prev, ...patch }))}
        onSubmit={submitReviewModal}
      />

      <ConnectMcpModal
        open={connectMcpModalOpen}
        onClose={() => setConnectMcpModalOpen(false)}
        onSubmit={submitConnectMcp}
      />

      <StandaloneRunModal
        run={standaloneRun}
        description={standaloneRunDescription}
        onClose={() => setStandaloneRun(null)}
        onDescriptionChange={setStandaloneRunDescription}
        onSubmit={() => {
          if (standaloneRun) {
            if (standaloneRun.type === 'agent') sendToVSCode('runAgent', { agent: standaloneRun.agent, description: standaloneRunDescription });
            else sendToVSCode('runSkill', { skill: standaloneRun.skill, description: standaloneRunDescription });
            setStandaloneRun(null);
          }
        }}
      />

      <HistoryModal
        target={historyTarget}
        runs={adhocRuns}
        onResume={run => sendToVSCode('resumeSession', { sessionId: run.sessionId, projectPath: run.projectPath, name: run.name, kind: run.kind })}
        onClose={closeHistory}
      />

      <RunInputsModal
        target={runInputsTarget}
        editing={runInputsEditing}
        runName={runName}
        values={runInputValues}
        error={runInputsError}
        onClose={() => { setRunInputsTarget(null); setRunInputsEditing(false); }}
        onRunNameChange={setRunName}
        onGenerateName={generateRunName}
        onValueChange={(k, v) => setRunInputValues(prev => ({ ...prev, [k]: v }))}
        onSubmit={submitRunInputs}
      />

      <FlowBuilderModal
        open={!!editingFlow && !editingStep}
        flow={editingFlow}
        scope={editingFlowScope}
        error={builderError}
        agents={agents}
        skills={skills}
        newInputName={newInputName}
        aiPrompt={flowAiPrompt}
        aiMessages={flowAiMessages}
        aiLoading={flowAiLoading}
        onClose={requestClose('flow', closeFlowModal)}
        onSave={saveEditingFlow}
        onChange={patch => setEditingFlow(prev => prev ? ({ ...prev, ...patch }) : null)}
        onChangeScope={setEditingFlowScope}
        onNewInputNameChange={setNewInputName}
        onAiPromptChange={setFlowAiPrompt}
        onGenerateFlow={() => {
          if (!editingFlow || !flowAiPrompt.trim() || flowAiLoading) return;
          const prompt = flowAiPrompt.trim();
          const history = [...flowAiMessages, { role: 'user' as const, content: prompt }];
          setFlowAiMessages(history);
          setFlowAiPrompt('');
          setBuilderError(null);
          setFlowAiLoading(true);
          if (!isVSCodeWebview()) {
            const agent = agents[0]?.name || '';
            const skill = skills[0]?.name || '';
            setEditingFlow({
              ...editingFlow,
              name: editingFlow.name || 'Generated workflow',
              description: editingFlow.description || prompt,
              steps: [
                {
                  id: 'step-1',
                  title: 'Plan the work',
                  agent,
                  skill,
                  skills: skill ? [skill] : [],
                  dependsOn: [],
                  review: { required: true, type: 'ai' }
                },
                {
                  id: 'step-2',
                  title: 'Implement and verify',
                  agent,
                  skill,
                  skills: skill ? [skill] : [],
                  dependsOn: ['step-1'],
                  review: { required: true, type: 'ai' }
                }
              ]
            });
            setFlowAiMessages([...history, { role: 'assistant', content: 'Preview workflow generated.' }]);
            setFlowAiLoading(false);
            return;
          }
          sendToVSCode('generateFlow', { description: prompt, flow: editingFlow, history });
        }}
        onAddStep={() => {
          if (!editingFlow) return;
          const previous = editingFlow.steps[editingFlow.steps.length - 1];
          const newStep: FlowStep = {
            id: `step-${Date.now()}`,
            title: '',
            agent: '',
            skill: '',
            dependsOn: previous ? [previous.id] : [],
            review: { required: true, type: 'ai' }
          };
          setEditingStep({ step: newStep, index: editingFlow.steps.length });
          setStepIsNew(true);
          setStepEditFromBoard(false);
        }}
        onEditStep={(step, index) => {
          setEditingStep({ step: JSON.parse(JSON.stringify(step)), index });
          setStepIsNew(false);
          setStepEditFromBoard(false);
        }}
        onDeleteStep={index => {
          if (!editingFlow) return;
          const removed = editingFlow.steps[index];
          const newSteps = [...editingFlow.steps];
          newSteps.splice(index, 1);
          setEditingFlow({
            ...editingFlow,
            steps: newSteps.map(step => ({
              ...step,
              dependsOn: (step.dependsOn || []).filter(id => id !== removed?.id)
            }))
          });
        }}
        onDragStart={(_e, index) => { (window as any)._dragIndex = index; }}
        onDrop={(_e, index) => {
          if (!editingFlow) return;
          const from = (window as any)._dragIndex;
          const to = index;
          const newSteps = [...editingFlow.steps];
          const [moved] = newSteps.splice(from, 1);
          newSteps.splice(to, 0, moved);
          setEditingFlow({ ...editingFlow, steps: newSteps });
        }}
        getAgentByName={getAgentByName}
        getSkillByName={getSkillByName}
        renderScopeBadge={renderScopeBadge}
      />

      <StepModal
        open={!!editingStep && !!editingFlow}
        step={editingStep?.step || null}
        stepIsNew={stepIsNew}
        stepEditFromBoard={stepEditFromBoard}
        error={stepError}
        agents={agents}
        skills={skills}
        reviewKits={reviewKits}
        flowSteps={editingFlow?.steps || []}
        onClose={() => { setEditingStep(null); if (stepEditFromBoard) setEditingFlow(null); }}
        onSave={saveStepEdit}
        onChange={patch => setEditingStep(prev => prev ? ({ ...prev, step: { ...prev.step, ...patch } }) : null)}
        getItemScope={getItemScope}
      />

      <ConfirmDialog
        open={pendingCancelGen !== null}
        title="Cancel AI generation?"
        message="Generation is still in progress. Closing will cancel all related generation processes."
        confirmLabel="Cancel & close"
        cancelLabel="Keep generating"
        danger
        onConfirm={() => {
          const which = pendingCancelGen;
          sendToVSCode('cancelGenerate');
          if (which === 'flow') { setFlowAiLoading(false); closeFlowModal(); }
          else if (which === 'agent') { setDraftLoading(null); closeAgentModal(); }
          else if (which === 'skill') { setDraftLoading(null); closeSkillModal(); }
          setPendingCancelGen(null);
        }}
        onCancel={() => setPendingCancelGen(null)}
      />
    </div>
  );
};

export default App;
