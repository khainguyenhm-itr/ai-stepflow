import React from 'react';
import { FlowStep, } from '@ai-stepflow/core/types';
import './App.css';
import { sendToVSCode } from './vscode';
import { getStepSkills } from './flowUtils';
import { useVsCodeBridge } from './hooks/useVsCodeBridge';
import { useAppLogic } from './hooks/useAppLogic';

import { FlowsTab } from './tabs/FlowsTab';
import { AgentsTab } from './tabs/AgentsTab';
import { SkillsTab } from './tabs/SkillsTab';
import { DetailModal } from './modals/DetailModal';
import { AgentModal } from './modals/AgentModal';
import { SkillModal } from './modals/SkillModal';
import { ConnectMcpModal } from './modals/ConnectMcpModal';
import { RunInputsModal } from './modals/RunInputsModal';
import { FlowBuilderModal } from './modals/FlowBuilderModal';
import { StepModal } from './modals/StepModal';
import { StandaloneRunModal } from './modals/StandaloneRunModal';

const App: React.FC = () => {
  const logic = useAppLogic();
  const {
    activeTab, setActiveTab,
    flows, agents, skills, auditLogs,
    globalPath, projectPath, connectedMcpServers,
    activeFlow, setActiveFlow,
    runState,
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
    startOrResumeRun,
    emptyAgentForm, emptySkillForm,
    submitAgentModal, openAgentEditor, submitSkillModal, openSkillEditor,
    submitConnectMcp,
    submitRunInputs, runActiveStep, saveEditingFlow, saveStepEdit
  } = logic;

  useVsCodeBridge(handleHostMessage, seedPreview);

  const getScope = (sourcePath: string) => {
    if (globalPath && sourcePath.startsWith(globalPath)) return 'Global';
    if (projectPath && sourcePath.startsWith(projectPath)) return 'Current repo';
    return sourcePath.includes('/preview/') ? 'Preview' : 'Current repo';
  };

  const renderScopeBadge = (sourcePath: string) => {
    const scope = getItemScope(sourcePath);
    return <span className="badge scope">{scope === 'global' ? 'global' : 'repo'}</span>;
  };

  const tabs: { key: typeof activeTab; label: string; count: number }[] = [
    { key: 'flows', label: 'Workflows', count: flows.length },
    { key: 'agents', label: 'Agents', count: agents.length },
    { key: 'skills', label: 'Skills', count: skills.length }
  ];

  return (
    <div className="app">
      <nav className="tab-bar">
        {tabs.map(tab => (
          <button
            key={tab.key}
            className={`tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
            <span className="tab-count">{tab.count}</span>
          </button>
        ))}
      </nav>

      {activeTab === 'flows' && (
        <FlowsTab
          flows={flows}
          agents={agents}
          skills={skills}
          auditLogs={auditLogs}
          activeFlow={activeFlow}
          runState={runState}
          runnerVisible={runnerVisible}
          activeStepId={activeStepId}
          completedSteps={completedSteps}
          activeProgress={activeProgress}
          commandCopied={commandCopied}
          globalPath={globalPath}
          projectPath={projectPath}
          onRun={flow => {
            if (activeFlow?.id === flow.id && runState && runnerVisible) {
              setRunnerVisible(false);
              return;
            }
            startOrResumeRun(flow);
            setRunnerVisible(true);
          }}
          onEdit={flow => {
            setEditingFlow(JSON.parse(JSON.stringify(flow)));
            setEditingFlowScope(getFlowScope(flow));
            setBuilderError(null);
            setNewInputName('');
          }}
          onDetail={flow => setDetailItem({
            type: 'Flow',
            title: flow.name,
            description: flow.description,
            sourcePath: flow.sourcePath,
            meta: { Scope: getScope(flow.sourcePath), Steps: flow.steps.length, Inputs: Object.keys(flow.inputs || {}).length },
            onDelete: () => sendToVSCode('deleteFlow', { flow })
          })}
          onNew={(flow, scope) => {
            setEditingFlow(flow);
            setEditingFlowScope(scope);
            setBuilderError(null);
            setNewInputName('');
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
              title: 'New Step',
              agent: '',
              skill: '',
              dependsOn: previous ? [previous.id] : [],
              review: { required: false },
              completion: { requireMarkDone: true }
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
          onSetActiveStep={setActiveStepId}
          onRunStep={runActiveStep}
          onOpenFile={path => sendToVSCode('openFile', { path })}
          onCopyCommand={() => {
            const step = activeFlow?.steps.find(s => s.id === activeStepId);
            if (!step) return;
            const skills = getStepSkills(step);
            const cmd = skills.map(s => `/${s}`).join(' ');
            navigator.clipboard.writeText(cmd);
            setCommandCopied(true);
            window.setTimeout(() => setCommandCopied(false), 1200);
          }}
          outputEndRef={outputEndRef}
        />
      )}

      {activeTab === 'agents' && (
        <AgentsTab
          agents={agents}
          globalPath={globalPath}
          projectPath={projectPath}
          onOpenEditor={openAgentEditor}
          onRun={agent => {
            setStandaloneRun({ type: 'agent', agent });
            setStandaloneRunDescription('');
          }}
          onDetail={agent => setDetailItem({
            type: 'Agent',
            title: agent.name,
            description: agent.description,
            sourcePath: agent.sourcePath,
            meta: { Scope: getScope(agent.sourcePath), Model: agent.model },
            onDelete: () => sendToVSCode('deleteAgent', { agent })
          })}
          onNew={scope => openAgentEditor({ name: '', description: '', model: 'claude-sonnet-4-6', tools: [], systemPrompt: '', sourcePath: scope === 'global' ? globalPath : projectPath })}
        />
      )}

      {activeTab === 'skills' && (
        <SkillsTab
          skills={skills}
          globalPath={globalPath}
          projectPath={projectPath}
          onOpenEditor={openSkillEditor}
          onRun={skill => {
            setStandaloneRun({ type: 'skill', skill });
            setStandaloneRunDescription('');
          }}
          onDetail={skill => setDetailItem({
            type: 'Skill',
            title: skill.name,
            description: skill.description,
            sourcePath: skill.sourcePath,
            meta: { Scope: getScope(skill.sourcePath) },
            onDelete: () => sendToVSCode('deleteSkill', { skill })
          })}
          onNew={scope => openSkillEditor({ name: '', description: '', instructions: '', sourcePath: scope === 'global' ? globalPath : projectPath })}
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
        onClose={() => { setAgentModalOpen(false); setEditingAgentSource(null); }}
        onConnectMcp={() => setConnectMcpModalOpen(true)}
        onChange={patch => setAgentForm(prev => ({ ...prev, ...patch }))}
        onSubmit={submitAgentModal}
        onGenerateDraft={() => {
          setDraftLoading('agent');
          setAgentFormError(null);
          sendToVSCode('generateDraft', { kind: 'agent', name: agentForm.name.trim(), description: agentForm.description });
        }}
      />

      <SkillModal
        open={skillModalOpen}
        editingSource={editingSkillSource}
        form={skillForm}
        error={skillFormError}
        draftLoading={draftLoading === 'skill'}
        onClose={() => { setSkillModalOpen(false); setEditingSkillSource(null); }}
        onChange={patch => setSkillForm(prev => ({ ...prev, ...patch }))}
        onSubmit={submitSkillModal}
        onGenerateDraft={() => {
          setDraftLoading('skill');
          setSkillFormError(null);
          sendToVSCode('generateDraft', { kind: 'skill', name: skillForm.name.trim(), description: skillForm.description });
        }}
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

      <RunInputsModal target={runInputsTarget} values={runInputValues} error={runInputsError} onClose={() => setRunInputsTarget(null)} onValueChange={(k, v) => setRunInputValues(prev => ({ ...prev, [k]: v }))} onSubmit={submitRunInputs} />

      <FlowBuilderModal
        open={!!editingFlow && !editingStep}
        flow={editingFlow}
        scope={editingFlowScope}
        error={builderError}
        agents={agents}
        skills={skills}
        newInputName={newInputName}
        onClose={() => setEditingFlow(null)}
        onSave={saveEditingFlow}
        onChange={patch => setEditingFlow(prev => prev ? ({ ...prev, ...patch }) : null)}
        onChangeScope={setEditingFlowScope}
        onNewInputNameChange={setNewInputName}
        onAddStep={() => {
          if (!editingFlow) return;
          const previous = editingFlow.steps[editingFlow.steps.length - 1];
          const newStep: FlowStep = {
            id: `step-${Date.now()}`,
            title: 'New Step',
            agent: '',
            skill: '',
            dependsOn: previous ? [previous.id] : [],
            review: { required: false },
            completion: { requireMarkDone: true }
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
        flowSteps={editingFlow?.steps || []}
        onClose={() => { setEditingStep(null); if (stepEditFromBoard) setEditingFlow(null); }}
        onSave={saveStepEdit}
        onChange={patch => setEditingStep(prev => prev ? ({ ...prev, step: { ...prev.step, ...patch } }) : null)}
        getItemScope={getItemScope}
      />
    </div>
  );
};

export default App;
