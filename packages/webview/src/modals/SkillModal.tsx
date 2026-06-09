import React from 'react';
import { SkillInput } from '@ai-stepflow/core';
import { Modal, Field, Icon } from '../components/primitives';
import { SaveScope, SaveScopeSelect } from '../components/ScopeControls';

interface SkillModalProps {
  open: boolean;
  editingSource: string | null;
  form: SkillInput & { scope: SaveScope };
  error: string | null;
  draftLoading: boolean;
  onClose: () => void;
  onChange: (patch: Partial<SkillInput & { scope: SaveScope }>) => void;
  onSubmit: () => void;
  onGenerateDraft: () => void;
}

export const SkillModal: React.FC<SkillModalProps> = ({
  open,
  editingSource,
  form,
  error,
  draftLoading,
  onClose,
  onChange,
  onSubmit,
  onGenerateDraft
}) => (
  <Modal
    title={editingSource ? 'Edit Skill' : 'New Skill'}
    open={open}
    onClose={onClose}
    width={560}
    footer={(
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={onSubmit}>{editingSource ? 'Save' : 'Create'}</button>
      </>
    )}
  >
    <div className="stack">
      {error && <div className="error-banner">{error}</div>}
      <Field label="Save location">
        <SaveScopeSelect value={form.scope} onChange={scope => onChange({ scope })} />
      </Field>
      <Field label="Name">
        <input className="input" placeholder="create-plan" value={form.name} onChange={e => onChange({ name: e.target.value })} />
      </Field>
      <Field label="Description">
        <input className="input" placeholder="Creates an implementation plan" value={form.description} onChange={e => onChange({ description: e.target.value })} />
      </Field>
      <Field label="Instructions" hint="write manually, or let AI draft them from the name & description">
        <div className="textarea-wrap">
          <textarea className="input" rows={8} placeholder="Write the reusable skill instructions." value={form.instructions} onChange={e => onChange({ instructions: e.target.value })} />
          <button
            type="button"
            className={`icon-btn ai-draft ${draftLoading ? 'loading' : ''}`}
            disabled={!form.name?.trim() || draftLoading}
            aria-label="AI draft instructions"
            onClick={onGenerateDraft}
          >
            {draftLoading ? <Icon.RotateCw size={14} className="spin" /> : <Icon.Sparkles size={14} />}
          </button>
        </div>
      </Field>
    </div>
  </Modal>
);
