import React from 'react';
import { Flow, FlowStep, Agent, Skill } from '@ai-stepflow/core/types';
import { Modal, Field, CheckRow, Icon } from '../components/primitives';
import { SaveScope, SaveScopeSelect } from '../components/ScopeControls';
import { getStepSkills } from '../flowUtils';

interface FlowBuilderModalProps {
  open: boolean;
  flow: Flow | null;
  scope: SaveScope;
  error: string | null;
  agents: Agent[];
  skills: Skill[];
  newInputName: string;
  onClose: () => void;
  onSave: () => void;
  onChange: (patch: Partial<Flow>) => void;
  onChangeScope: (scope: SaveScope) => void;
  onNewInputNameChange: (name: string) => void;
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
  agents,
  skills,
  newInputName,
  onClose,
  onSave,
  onChange,
  onChangeScope,
  onNewInputNameChange,
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
      title="Edit Flow"
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
        <div className="form-grid">
          <Field label="Save location">
            <SaveScopeSelect value={scope} onChange={onChangeScope} />
          </Field>
          <Field label="Flow name">
            <input className="input" value={flow.name} onChange={e => onChange({ name: e.target.value })} />
          </Field>
        </div>
        <Field label="Description">
          <textarea className="input" rows={2} value={flow.description} onChange={e => onChange({ description: e.target.value })} />
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
                    inputs: { ...(flow.inputs || {}), [name]: { type: 'string', required: true, label: name } }
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
                    const { [name]: _removed, ...rest } = flow.inputs || {};
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
