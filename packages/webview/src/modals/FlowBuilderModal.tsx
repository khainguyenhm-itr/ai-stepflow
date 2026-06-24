import React from 'react';
import { Flow, FlowStep, Agent, Skill } from '@ai-stepflow/core/types';
import { Modal, Field, CheckRow, Icon } from '../components/primitives';
import { SaveScope, SaveScopeSelect } from '../components/ScopeControls';
import { getStepSkills } from '../flowUtils';

/** NFD-decompose, strip combining diacritics, map đ→d, drop remaining non-printable-ASCII. */
const COMBINING = new RegExp('[\\u0300-\\u036f]', 'g');
const toAsciiName = (s: string) =>
  s.normalize('NFD').replace(COMBINING, '').replace(/[đĐ]/g, m => m === 'đ' ? 'd' : 'D').replace(/[^\x20-\x7E]/g, '');

interface FlowBuilderModalProps {
  open: boolean;
  flow: Flow | null;
  scope: SaveScope;
  error: string | null;
  agents: Agent[];
  skills: Skill[];
  newInputName: string;
  aiPrompt: string;
  aiMessages: { role: 'user' | 'assistant'; content: string }[];
  aiLoading: boolean;
  onClose: () => void;
  onSave: () => void;
  onChange: (patch: Partial<Flow>) => void;
  onChangeScope: (scope: SaveScope) => void;
  onNewInputNameChange: (name: string) => void;
  onAiPromptChange: (value: string) => void;
  onGenerateFlow: () => void;
  onAddStep: () => void;
  onEditStep: (step: FlowStep, index: number) => void;
  onDeleteStep: (index: number) => void;
  onDragStart: (e: React.DragEvent, index: number) => void;
  onDrop: (e: React.DragEvent, index: number) => void;
  getAgentByName: (name: string) => Agent | undefined;
  getSkillByName: (name: string) => Skill | undefined;
  renderScopeBadge: (sourcePath: string) => React.ReactNode;
}

export const FlowBuilderModal: React.FC<FlowBuilderModalProps> = ({
  open,
  flow,
  scope,
  error,
  newInputName,
  aiPrompt,
  aiMessages,
  aiLoading,
  onClose,
  onSave,
  onChange,
  onChangeScope,
  onNewInputNameChange,
  onAiPromptChange,
  onGenerateFlow,
  onAddStep,
  onEditStep,
  onDeleteStep,
  onDragStart,
  onDrop,
  getAgentByName,
  getSkillByName,
  renderScopeBadge
}) => {
  if (!flow) return null;

  return (
    <Modal
      title={flow.sourcePath ? 'Edit Flow' : 'New Workflow'}
      open={open}
      onClose={onClose}
      width={760}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={onSave}>Save</button>
        </>
      )}
    >
      <div className="stack">
        {error && <div className="error-banner">{error}</div>}
        <div className="flow-ai-section">
          <div className="flow-ai-header">
            <Icon.Sparkles size={15} className="flow-ai-icon" />
            <div>
              <span className="flow-ai-title">Generate with AI</span>
              <span className="flow-ai-hint">Describe what you want — AI will build the steps for you</span>
            </div>
          </div>
          {aiMessages.length > 0 && (
            <div className="flow-ai-chat" aria-live="polite">
              {aiMessages.map((message, index) => (
                <div key={index} className={`flow-ai-message ${message.role}`}>
                  <span className="flow-ai-role">{message.role === 'user' ? 'You' : 'AI'}</span>
                  <span>{message.content}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flow-ai-compose">
            <textarea
              className="input"
              rows={3}
              placeholder="e.g. Create a workflow to analyze a bug, implement the fix, run tests, and review the patch."
              value={aiPrompt}
              onChange={e => onAiPromptChange(e.target.value)}
            />
            <div className="flow-ai-actions">
              <button
                type="button"
                className="btn primary"
                disabled={!aiPrompt.trim() || aiLoading}
                onClick={onGenerateFlow}
              >
                <span className="btn-glyph">{aiLoading ? <Icon.RotateCw size={14} className="spin" /> : <Icon.Sparkles size={14} />}</span>
                {aiMessages.length > 0 ? 'Regenerate' : 'Generate'}
              </button>
            </div>
          </div>
        </div>
        <div className="divider-label">or configure manually</div>
        <div className="form-grid">
          <Field label="Save location">
            <SaveScopeSelect value={scope} onChange={onChangeScope} />
          </Field>
          <Field label="Flow name" hint="Max 60 chars — used as output folder name (non-ASCII auto-converted)">
            <input className="input" placeholder="e.g. Release workflow" value={flow.name} onChange={e => onChange({ name: toAsciiName(e.target.value) })} />
          </Field>
        </div>
        <Field label="Description">
          <textarea className="input" rows={2} placeholder="Describe what this workflow does." value={flow.description} onChange={e => onChange({ description: e.target.value })} />
        </Field>
        <Field label="Run inputs" hint="collected when a run starts; passed to Claude with every step">
          <div className="stack tight">
            <div className="inline-row">
              <input
                className="input"
                placeholder="input name (e.g. ticket-id)"
                value={newInputName}
                onChange={e => onNewInputNameChange(e.target.value)}
              />
              <button
                className="btn"
                disabled={!newInputName.trim() || !!flow.inputs?.[newInputName.trim()]}
                onClick={() => {
                  const name = newInputName.trim();
                  onChange({
                    inputs: { ...(flow.inputs || {}), [name]: { type: 'string', required: true, label: '' } }
                  });
                  onNewInputNameChange('');
                }}
              >
                Add
              </button>
            </div>
            {Object.entries(flow.inputs || {}).map(([name, def]) => (
              <div className="input-def-row" key={name}>
                <code className="mono">{name}</code>
                <input
                  className="input"
                  placeholder="Label"
                  value={def.label}
                  onChange={e => onChange({
                    inputs: { ...flow.inputs, [name]: { ...def, label: e.target.value } }
                  })}
                />
                <CheckRow
                  label="required"
                  checked={!!def.required}
                  onChange={checked => onChange({
                    inputs: { ...flow.inputs, [name]: { ...def, required: checked } }
                  })}
                />
                <button
                  className="icon-btn danger"
                  title="Remove input"
                  onClick={() => {
                    const rest = { ...(flow.inputs || {}) };
                    delete rest[name];
                    onChange({ inputs: rest });
                  }}
                >
                  <Icon.X size={14} />
                </button>
              </div>
            ))}
          </div>
        </Field>
        <div className="section-label">Workflow Steps</div>
        <div className="step-list">
          {flow.steps.length === 0 && <div className="muted pad-sm">No steps configured.</div>}
          {flow.steps.map((step, index) => (
            <div
              key={step.id}
              className="step-list-item"
              draggable
              onDragStart={e => onDragStart(e, index)}
              onDragOver={e => e.preventDefault()}
              onDrop={e => onDrop(e, index)}
            >
              <span className="drag-handle" title="Drag to reorder"><Icon.GripVertical size={14} /></span>
              <div className="step-list-main">
                <span className="step-list-title">{step.title || step.id}</span>
                <span className="muted small">
                  {step.agent || 'No agent'}
                  {getAgentByName(step.agent) && <> {renderScopeBadge(getAgentByName(step.agent)!.sourcePath)}</>}
                  {' / '}
                  {getStepSkills(step).length === 0 ? 'No skill' : getStepSkills(step).map((skillName, skillIndex) => (
                    <React.Fragment key={skillName}>
                      {skillIndex > 0 && ', '}
                      {skillName}
                      {getSkillByName(skillName) && <> {renderScopeBadge(getSkillByName(skillName)!.sourcePath)}</>}
                    </React.Fragment>
                  ))}
                </span>
              </div>
              <button className="icon-btn boxed" title="Configure step" onClick={() => onEditStep(step, index)}><Icon.Settings size={14} /></button>
              <button className="icon-btn boxed danger" title="Delete step" onClick={() => onDeleteStep(index)}><Icon.X size={14} /></button>
            </div>
          ))}
        </div>
        <button
          className="btn block dashed"
          onClick={onAddStep}
        >
          <span className="btn-glyph plus"><Icon.Plus size={14} /></span>Add Step
        </button>
      </div>
    </Modal>
  );
};
