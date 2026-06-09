import React from 'react';
import { AgentInput } from '@ai-stepflow/core';
import { Modal, Field, Icon } from '../components/primitives';
import { SaveScope, SaveScopeSelect } from '../components/ScopeControls';

const availableModels = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5'
];

const standardCapabilities = [
  { value: 'jira', label: 'Jira' },
  { value: 'figma', label: 'Figma' },
  { value: 'core-business', label: 'Core docs' },
  { value: 'its', label: 'ITS' },
  { value: 'github', label: 'GitHub' },
  { value: 'slack', label: 'Slack' },
  { value: 'files', label: 'Files', builtIn: true },
  { value: 'web', label: 'Web', builtIn: true }
];

interface AgentModalProps {
  open: boolean;
  editingSource: string | null;
  form: AgentInput & { scope: SaveScope };
  error: string | null;
  draftLoading: boolean;
  connectedMcpServers: string[];
  onClose: () => void;
  onChange: (patch: Partial<AgentInput & { scope: SaveScope }>) => void;
  onSubmit: () => void;
  onGenerateDraft: () => void;
}

export const AgentModal: React.FC<AgentModalProps> = ({
  open,
  editingSource,
  form,
  error,
  draftLoading,
  connectedMcpServers,
  onClose,
  onChange,
  onSubmit,
  onGenerateDraft
}) => {
  const connected = new Set(connectedMcpServers.map(name => name.toLowerCase()));
  const standardValues = new Set(standardCapabilities.map(capability => capability.value));
  const knownValues = new Set([...standardValues, ...connected]);
  const capabilities = [
    ...standardCapabilities,
    ...connectedMcpServers
      .filter(server => !standardValues.has(server.toLowerCase()))
      .map(server => ({ value: server, label: server, builtIn: false })),
    ...(form.tools || [])
      .filter(tool => !knownValues.has(tool.toLowerCase()))
      .map(tool => ({ value: tool, label: tool, builtIn: false }))
  ];
  const selectedTools = new Set(form.tools || []);
  const toggleTool = (tool: string, checked: boolean) => {
    const next = new Set(selectedTools);
    if (checked) next.add(tool);
    else next.delete(tool);
    onChange({ tools: Array.from(next) });
  };

  return (
  <Modal
    title={editingSource ? 'Edit Agent' : 'New Agent'}
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
        <input className="input" placeholder="aidlc-reviewer" value={form.name} onChange={e => onChange({ name: e.target.value })} />
      </Field>
      <Field label="Description">
        <input className="input" placeholder="Reviews generated internal documentation" value={form.description} onChange={e => onChange({ description: e.target.value })} />
      </Field>
      <Field label="Model">
        <select className="select" value={form.model} onChange={e => onChange({ model: e.target.value })}>
          {form.model && !availableModels.includes(form.model) && (
            <option value={form.model}>{form.model} (current)</option>
          )}
          {availableModels.map(model => <option key={model} value={model}>{model}</option>)}
        </select>
      </Field>
      <Field label="Capabilities" hint="optional — connected MCP integrations the agent uses">
        <div className="capability-list">
          {capabilities.map(capability => {
            const enabled = capability.builtIn || connected.has(capability.value.toLowerCase());
            return (
              <label
                key={capability.value}
                className={`capability-chip ${enabled ? '' : 'disabled'}`}
                title={enabled ? capability.value : `${capability.label} MCP is not connected`}
              >
                <input
                  type="checkbox"
                  checked={selectedTools.has(capability.value)}
                  disabled={!enabled}
                  onChange={event => toggleTool(capability.value, event.target.checked)}
                />
                <span>{capability.label}</span>
              </label>
            );
          })}
        </div>
      </Field>
      <Field label="System Prompt" hint="write manually, or let AI draft it from the name & description">
        <div className="textarea-wrap">
          <textarea className="input" rows={6} placeholder="Describe the agent role and operating rules." value={form.systemPrompt} onChange={e => onChange({ systemPrompt: e.target.value })} />
          <button
            type="button"
            className={`icon-btn ai-draft ${draftLoading ? 'loading' : ''}`}
            disabled={!form.name?.trim() || draftLoading}
            aria-label="AI draft system prompt"
            onClick={onGenerateDraft}
          >
            {draftLoading ? <Icon.RotateCw size={14} className="spin" /> : <Icon.Sparkles size={14} />}
          </button>
        </div>
      </Field>
    </div>
  </Modal>
  );
};
