import React from 'react';
import { ReviewKitInput } from '@ai-stepflow/core';
import { Modal, Field } from '../components/primitives';
import { SaveScope, SaveScopeSelect } from '../components/ScopeControls';

interface ReviewModalProps {
  open: boolean;
  editingSource: string | null;
  form: ReviewKitInput & { scope: SaveScope };
  error: string | null;
  onClose: () => void;
  onChange: (patch: Partial<ReviewKitInput & { scope: SaveScope }>) => void;
  onSubmit: () => void;
}

export const ReviewModal: React.FC<ReviewModalProps> = ({
  open,
  editingSource,
  form,
  error,
  onClose,
  onChange,
  onSubmit
}) => (
  <Modal
    title={editingSource ? 'Edit Review Kit' : 'New Review Kit'}
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
        <input className="input" placeholder="aisf-review-default" value={form.name} onChange={e => onChange({ name: e.target.value })} />
      </Field>
      <Field label="Description">
        <input className="input" placeholder="Reviews produced artifacts for correctness" value={form.description} onChange={e => onChange({ description: e.target.value })} />
      </Field>
      <Field label="Prompt" hint="the review-kit prompt body read by the deep-LLM-review layer">
        <textarea className="input" rows={12} placeholder="Write the review prompt the LLM reviewer will follow." value={form.content} onChange={e => onChange({ content: e.target.value })} />
      </Field>
    </div>
  </Modal>
);
