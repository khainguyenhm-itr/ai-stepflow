import { useState } from 'react';
import { Flow, FlowStep } from '@ai-stepflow/core/types';
import { SaveScope } from './types';

export const useBuilderState = () => {
  const [editingFlow, setEditingFlow] = useState<Flow | null>(null);
  const [editingFlowScope, setEditingFlowScope] = useState<SaveScope>('project');
  const [editingStep, setEditingStep] = useState<{ step: FlowStep, index: number } | null>(null);
  const [stepEditFromBoard, setStepEditFromBoard] = useState(false);
  const [stepIsNew, setStepIsNew] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [newInputName, setNewInputName] = useState('');

  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [connectMcpModalOpen, setConnectMcpModalOpen] = useState(false);
  const [editingSkillSource, setEditingSkillSource] = useState<string | null>(null);
  const [editingAgentSource, setEditingAgentSource] = useState<string | null>(null);

  const emptyAgentForm = { name: '', description: '', model: 'claude-sonnet-4-6', tools: [] as string[], systemPrompt: '', scope: 'project' as SaveScope, maxTurns: undefined as number | undefined, tags: [] as string[] };
  const emptySkillForm = { name: '', description: '', instructions: '', scope: 'project' as SaveScope, tags: [] as string[] };
  
  const [agentForm, setAgentForm] = useState(emptyAgentForm);
  const [skillForm, setSkillForm] = useState(emptySkillForm);
  const [agentFormError, setAgentFormError] = useState<string | null>(null);
  const [skillFormError, setSkillFormError] = useState<string | null>(null);
  const [draftLoading, setDraftLoading] = useState<'agent' | 'skill' | null>(null);

  return {
    editingFlow, setEditingFlow,
    editingFlowScope, setEditingFlowScope,
    editingStep, setEditingStep,
    stepEditFromBoard, setStepEditFromBoard,
    stepIsNew, setStepIsNew,
    stepError, setStepError,
    builderError, setBuilderError,
    newInputName, setNewInputName,
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
    emptyAgentForm, emptySkillForm
  };
};
