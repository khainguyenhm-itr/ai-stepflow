import React from 'react';
import { FlowStep, Agent, Skill } from '@ai-stepflow/core/types';
import { Modal, Field, CheckRow, Icon } from '../components/primitives';
import { getStepSkills } from '../flowUtils';
import { SaveScope } from '../components/ScopeControls';

interface StepModalProps {
  open: boolean;
  step: FlowStep | null;
  stepIsNew: boolean;
  stepEditFromBoard: boolean;
  error: string | null;
  agents: Agent[];
  skills: Skill[];
  flowSteps: FlowStep[];
  onClose: () => void;
  onSave: () => void;
  onChange: (patch: Partial<FlowStep>) => void;
  getItemScope: (path: string) => SaveScope;
}

export const StepModal: React.FC<StepModalProps> = ({
  open,
  step,
  stepIsNew,
  stepEditFromBoard,
  error,
  agents,
  skills,
  flowSteps,
  onClose,
  onSave,
  onChange,
  getItemScope
}) => {
  if (!step) return null;

  const parseList = (value: string): string[] =>
    value.split(/\r?\n|,/).map(item => item.trim()).filter(Boolean);

  const aiReviewer = step.review.reviewers?.find(r => r.type === 'ai');
  const setAiReviewer = (patch: { agent?: string; skill?: string }) => {
    const next = { agent: aiReviewer?.agent, skill: aiReviewer?.skill, ...patch };
    const reviewer: NonNullable<FlowStep['review']['reviewers']>[number] = { type: 'ai' };
    if (next.agent) reviewer.agent = next.agent;
    if (next.skill) reviewer.skill = next.skill;
    onChange({ review: { ...step.review, reviewers: [reviewer] } });
  };

  return (
    <Modal
      title={stepIsNew ? 'Add Step' : 'Configure Step'}
      open={open}
      onClose={onClose}
      width={520}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={onSave}>{stepIsNew ? 'Add step' : (stepEditFromBoard ? 'Save step' : 'Save')}</button>
        </>
      )}
    >
      <div className="stack">
        {error && <div className="error-banner">{error}</div>}
        <Field label="Step title">
          <input className="input" placeholder="e.g. Implement the feature" value={step.title} onChange={e => onChange({ title: e.target.value })} />
        </Field>
        <Field label="Agent">
          <select className="select" value={step.agent} onChange={e => onChange({ agent: e.target.value })}>
            {!step.agent && <option value="">(none)</option>}
            {agents.map(agent => (
              <option key={agent.name} value={agent.name}>{agent.name} ({getItemScope(agent.sourcePath) === 'global' ? 'global' : 'repo'})</option>
            ))}
          </select>
        </Field>
        <Field label="Skills" hint="check one or more; they run in the order checked">
          <div className="dep-list">
            {skills.length === 0 && <span className="muted">No skills available.</span>}
            {skills.map(skill => {
              const selected = getStepSkills(step);
              const checked = selected.includes(skill.name);
              return (
                <CheckRow
                  key={skill.name}
                  label={`${skill.name} (${getItemScope(skill.sourcePath) === 'global' ? 'global' : 'repo'})`}
                  checked={checked}
                  onChange={isChecked => {
                    const values = isChecked ? [...selected, skill.name] : selected.filter(name => name !== skill.name);
                    onChange({ skills: values, skill: values[0] || '' });
                  }}
                />
              );
            })}
          </div>
        </Field>
        <Field label="Dependencies" hint="steps that must be done before this one can run">
          <div className="dep-list">
            {flowSteps.filter(candidate => candidate.id !== step.id).length === 0 && <span className="muted">No other steps available.</span>}
            {flowSteps.filter(candidate => candidate.id !== step.id).map(candidate => {
              const selected = step.dependsOn || [];
              const checked = selected.includes(candidate.id);
              return (
                <CheckRow
                  key={candidate.id}
                  label={candidate.title || candidate.id}
                  checked={checked}
                  onChange={isChecked => {
                    const values = isChecked ? [...selected, candidate.id] : selected.filter(id => id !== candidate.id);
                    onChange({ dependsOn: values });
                  }}
                />
              );
            })}
          </div>
        </Field>
        <Field label="Review" hint={step.review.type === 'ai' ? 'auto review — the step is marked done automatically when it passes' : 'human review — you must press “Mark done” to complete the step'}>
          <select
            className="select"
            value={step.review.type === 'ai' ? 'ai' : 'human'}
            onChange={e => {
              const value = e.target.value as 'human' | 'ai';
              onChange({
                review: { ...step.review, required: true, type: value },
                completion: { requireMarkDone: value === 'human' }
              });
            }}
          >
            <option value="human">Human review</option>
            <option value="ai">Auto review</option>
          </select>
        </Field>
        {step.review.type === 'ai' && (
          <>
            <Field label="Validator module" hint="optional — JS/TS module that returns { decision, reason } for deterministic auto-review">
              <input
                className="input"
                placeholder="e.g. scripts/validate-plan.mjs"
                value={step.review.validatorPath || ''}
                onChange={e => onChange({ review: { ...step.review, validatorPath: e.target.value || undefined } })}
              />
            </Field>
            <Field label="Validator timeout (ms)" hint="optional — defaults to 120000">
              <input
                className="input"
                type="number"
                min={1}
                placeholder="120000"
                value={step.review.validatorTimeoutMs ?? ''}
                onChange={e => onChange({ review: { ...step.review, validatorTimeoutMs: e.target.value ? Number(e.target.value) : undefined } })}
              />
            </Field>
            <Field label="Reviewer agent" hint="optional — runs the auto review under this agent">
              <select
                className="select"
                value={aiReviewer?.agent || ''}
                onChange={e => setAiReviewer({ agent: e.target.value || undefined })}
              >
                <option value="">(default agent)</option>
                {agents.map(agent => (
                  <option key={agent.name} value={agent.name}>{agent.name} ({getItemScope(agent.sourcePath) === 'global' ? 'global' : 'repo'})</option>
                ))}
              </select>
            </Field>
            <Field label="Reviewer skill" hint="optional — the review is run as this skill (/skill)">
              <select
                className="select"
                value={aiReviewer?.skill || ''}
                onChange={e => setAiReviewer({ skill: e.target.value || undefined })}
              >
                <option value="">(no skill)</option>
                {skills.map(skill => (
                  <option key={skill.name} value={skill.name}>{skill.name} ({getItemScope(skill.sourcePath) === 'global' ? 'global' : 'repo'})</option>
                ))}
              </select>
            </Field>
          </>
        )}
        <Field label="Review file" hint="optional — artifact file the review is based on after this step runs. Use Requires for files that must exist before the step starts.">
          <input
            className="input"
            placeholder="e.g. docs/PLAN.md"
            value={step.review.filePath || ''}
            onChange={e => onChange({ review: { ...step.review, filePath: e.target.value || undefined } })}
          />
        </Field>
        <Field label="Requires" hint="one path per line or comma-separated; supports placeholders like docs/{ticket}/brief.md">
          <textarea
            className="input"
            rows={3}
            placeholder="e.g. docs/{ticket}/brief.md"
            value={(step.requires || []).join('\n')}
            onChange={e => onChange({ requires: parseList(e.target.value) })}
          />
        </Field>
        <Field label="Produces" hint="one path per line or comma-separated; supports placeholders like docs/{ticket}/plan.md">
          <textarea
            className="input"
            rows={3}
            placeholder="e.g. docs/{ticket}/plan.md"
            value={(step.produces || []).join('\n')}
            onChange={e => onChange({ produces: parseList(e.target.value) })}
          />
        </Field>
        <Field label="Required content markers" hint="plain substrings that must appear in at least one produced file">
          <textarea
            className="input"
            rows={3}
            placeholder="e.g. ## Summary"
            value={(step.producesContains || []).join('\n')}
            onChange={e => onChange({ producesContains: parseList(e.target.value) })}
          />
        </Field>
      </div>
    </Modal>
  );
};
