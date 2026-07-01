import React from 'react';
import { SkillInput } from '@ai-stepflow/core';
import { Modal, Field, Icon } from '../components/primitives';
import { SaveScope, SaveScopeSelect } from '../components/ScopeControls';
import { parseTagsInput } from '../tagUtils';

interface SkillModalProps {
  open: boolean;
  editingSource: string | null;
  form: SkillInput & { scope: SaveScope };
  error: string | null;
  draftLoading: boolean;
  aiPrompt: string;
  aiMessages: { role: 'user' | 'assistant'; content: string }[];
  onClose: () => void;
  onChange: (patch: Partial<SkillInput & { scope: SaveScope }>) => void;
  onSubmit: () => void;
  onAiPromptChange: (value: string) => void;
  onGenerateSkill: () => void;
}

export const SkillModal: React.FC<SkillModalProps> = ({
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
  onGenerateSkill
}) => {
  // Local raw text for the tags input so separators can be typed freely; re-synced per opened skill.
  const [tagsText, setTagsText] = React.useState((form.tags || []).join(', '));
  React.useEffect(() => { setTagsText((form.tags || []).join(', ')); }, [editingSource, open]);

  return (
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
      <div className="flow-ai-section">
        <div className="flow-ai-header">
          <Icon.Sparkles size={15} className="flow-ai-icon" />
          <div>
            <span className="flow-ai-title">Generate with AI</span>
            <span className="flow-ai-hint">Describe what you want — AI will write the instructions</span>
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
            placeholder="e.g. A skill that creates a detailed implementation plan from a feature request"
            value={aiPrompt}
            onChange={e => onAiPromptChange(e.target.value)}
          />
          <div className="flow-ai-actions">
            <button
              type="button"
              className="btn primary"
              disabled={!aiPrompt.trim() || draftLoading}
              onClick={onGenerateSkill}
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
        <input className="input" placeholder="create-plan" value={form.name} onChange={e => onChange({ name: e.target.value })} />
      </Field>
      <Field label="Description">
        <input className="input" placeholder="Creates an implementation plan" value={form.description} onChange={e => onChange({ description: e.target.value })} />
      </Field>
      <Field label="Groups / tags" hint="comma-separated — used to group skills (e.g. research, docs)">
        <input className="input" placeholder="research, docs" value={tagsText} onChange={e => { setTagsText(e.target.value); onChange({ tags: parseTagsInput(e.target.value) }); }} />
      </Field>
      <Field label="Instructions">
        <textarea className="input" rows={8} placeholder="Write the reusable skill instructions." value={form.instructions} onChange={e => onChange({ instructions: e.target.value })} />
      </Field>
    </div>
  </Modal>
  );
};
