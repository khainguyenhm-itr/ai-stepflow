import { useState } from 'react';
import { Flow, FlowStep } from '@claudesteps/core/types';
import { SaveScope } from './types';
import { FlowSaveOrigin } from './flowSaveOrigin';

export const useBuilderState = () => {
  const [editingFlow, setEditingFlow] = useState<Flow | null>(null);
  const [editingFlowScope, setEditingFlowScope] = useState<SaveScope>('project');
  const [editingStep, setEditingStep] = useState<{ step: FlowStep, index: number } | null>(null);
  const [stepEditFromBoard, setStepEditFromBoard] = useState(false);
  const [stepIsNew, setStepIsNew] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [newInputName, setNewInputName] = useState('');
  /** Where the in-flight `saveFlow` post came from, so a refusal restores exactly that context. */
  const [flowSaveOrigin, setFlowSaveOrigin] = useState<FlowSaveOrigin | null>(null);

  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [connectMcpModalOpen, setConnectMcpModalOpen] = useState(false);
  const [editingSkillSource, setEditingSkillSource] = useState<string | null>(null);
  const [editingAgentSource, setEditingAgentSource] = useState<string | null>(null);
  const [editingReviewSource, setEditingReviewSource] = useState<string | null>(null);
  // Source folder of a skill imported as a directory; echoed back on save so the host copies its resources.
  const [skillImportSourceDir, setSkillImportSourceDir] = useState<string | null>(null);

  const emptyAgentForm = { name: '', description: '', model: 'claude-sonnet-4-6', tools: [] as string[], systemPrompt: '', scope: 'project' as SaveScope, maxTurns: undefined as number | undefined, tags: [] as string[] };
  const emptySkillForm = { name: '', description: '', instructions: '', scope: 'project' as SaveScope, tags: [] as string[] };
  const emptyReviewForm = { name: '', description: '', content: '', scope: 'project' as SaveScope };

  const [agentForm, setAgentForm] = useState(emptyAgentForm);
  const [skillForm, setSkillForm] = useState(emptySkillForm);
  const [reviewForm, setReviewForm] = useState(emptyReviewForm);
  const [agentFormError, setAgentFormError] = useState<string | null>(null);
  const [skillFormError, setSkillFormError] = useState<string | null>(null);
  const [reviewFormError, setReviewFormError] = useState<string | null>(null);
  const [draftLoading, setDraftLoading] = useState<'agent' | 'skill' | 'review' | null>(null);

  return {
    editingFlow, setEditingFlow,
    editingFlowScope, setEditingFlowScope,
    editingStep, setEditingStep,
    stepEditFromBoard, setStepEditFromBoard,
    stepIsNew, setStepIsNew,
    stepError, setStepError,
    builderError, setBuilderError,
    newInputName, setNewInputName,
    flowSaveOrigin, setFlowSaveOrigin,
    agentModalOpen, setAgentModalOpen,
    skillModalOpen, setSkillModalOpen,
    reviewModalOpen, setReviewModalOpen,
    connectMcpModalOpen, setConnectMcpModalOpen,
    editingSkillSource, setEditingSkillSource,
    editingAgentSource, setEditingAgentSource,
    editingReviewSource, setEditingReviewSource,
    skillImportSourceDir, setSkillImportSourceDir,
    agentForm, setAgentForm,
    skillForm, setSkillForm,
    reviewForm, setReviewForm,
    agentFormError, setAgentFormError,
    skillFormError, setSkillFormError,
    reviewFormError, setReviewFormError,
    draftLoading, setDraftLoading,
    emptyAgentForm, emptySkillForm, emptyReviewForm
  };
};
