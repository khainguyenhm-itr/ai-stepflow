import React from 'react';
import { ReviewKitInput } from '@claudesteps/core';
import { Modal, Field, Icon } from '../components/primitives';
import { SaveScope, SaveScopeSelect } from '../components/ScopeControls';

interface ReviewModalProps {
  open: boolean;
  editingSource: string | null;
  form: ReviewKitInput & { scope: SaveScope };
  error: string | null;
  draftLoading: boolean;
  aiPrompt: string;
  aiMessages: { role: 'user' | 'assistant'; content: string }[];
  onClose: () => void;
  onChange: (patch: Partial<ReviewKitInput & { scope: SaveScope }>) => void;
  onSubmit: () => void;
  onAiPromptChange: (value: string) => void;
  onGenerateReview: () => void;
}

export const ReviewModal: React.FC<ReviewModalProps> = ({
  open,
  editingSource,
  form,
  error,
  draftLoading,
  aiPrompt,
  aiMessages,
  onClose,
  onChange,
  onSubmit,
  onAiPromptChange,
  onGenerateReview
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
      <div className="flow-ai-section">
        <div className="flow-ai-header">
          <Icon.Sparkles size={15} className="flow-ai-icon" />
          <div>
            <span className="flow-ai-title">Generate with AI</span>
            <span className="flow-ai-hint">Describe what the reviewer should judge — AI will write the criteria</span>
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
            placeholder="e.g. A reviewer that rejects a PRD whose acceptance criteria are not independently verifiable"
            value={aiPrompt}
            onChange={e => onAiPromptChange(e.target.value)}
          />
          <div className="flow-ai-actions">
            <button
              type="button"
              className="btn primary"
              disabled={!aiPrompt.trim() || draftLoading}
              onClick={onGenerateReview}
            >
              <span className="btn-glyph">{draftLoading ? <Icon.RotateCw size={14} className="spin" /> : <Icon.Sparkles size={14} />}</span>
              {aiMessages.length > 0 ? 'Regenerate' : 'Generate'}
            </button>
          </div>
        </div>
      </div>
      <div className="divider-label">or configure manually</div>
      <Field label="Save location">
        <SaveScopeSelect value={form.scope} onChange={scope => onChange({ scope })} />
      </Field>
      <Field label="Name">
        <input className="input" placeholder="csf-review-default" value={form.name} onChange={e => onChange({ name: e.target.value })} />
      </Field>
      <Field label="Description">
        <input className="input" placeholder="Reviews produced artifacts for correctness" value={form.description} onChange={e => onChange({ description: e.target.value })} />
      </Field>
      <Field label="Prompt" hint="review criteria only — the runner appends its own JSON verdict contract">
        <textarea className="input" rows={12} placeholder="Write the review criteria the LLM reviewer will follow." value={form.content} onChange={e => onChange({ content: e.target.value })} />
      </Field>
    </div>
  </Modal>
);
