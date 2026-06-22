import React from 'react';
import { AgentInput } from '@ai-stepflow/core';
import { Modal, Field, Icon } from '../components/primitives';
import { SaveScope, SaveScopeSelect } from '../components/ScopeControls';

// Aliases resolve to the latest model for each tier — the CLI maps them at run
// time, so this list never goes stale when Anthropic ships a new model.
const availableModels = [
  'default',
  'opus',
  'sonnet',
  'haiku'
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
  aiPrompt: string;
  aiMessages: { role: 'user' | 'assistant'; content: string }[];
  onClose: () => void;
  onConnectMcp: () => void;
  onChange: (patch: Partial<AgentInput & { scope: SaveScope }>) => void;
  onSubmit: () => void;
  onAiPromptChange: (value: string) => void;
  onGenerateAgent: () => void;
}

export const AgentModal: React.FC<AgentModalProps> = ({
  open,
  editingSource,
  form,
  error,
  draftLoading,
  connectedMcpServers,
  aiPrompt,
  aiMessages,
  onClose,
  onConnectMcp,
  onChange,
  onSubmit,
  onAiPromptChange,
  onGenerateAgent
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
      <div className="flow-ai-section">
        <div className="flow-ai-header">
          <Icon.Sparkles size={15} className="flow-ai-icon" />
          <div>
            <span className="flow-ai-title">Generate with AI</span>
            <span className="flow-ai-hint">Describe the agent role — AI will write the system prompt</span>
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
            placeholder="e.g. A code reviewer that checks for security vulnerabilities and code quality issues"
            value={aiPrompt}
            onChange={e => onAiPromptChange(e.target.value)}
          />
          <div className="flow-ai-actions">
            <button
              type="button"
              className="btn primary"
              disabled={!aiPrompt.trim() || draftLoading}
              onClick={onGenerateAgent}
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
          <button className="capability-chip add-new" onClick={onConnectMcp} title="Connect a new MCP server (GitHub, Figma, etc.)">
            <Icon.Plus size={12} />
            <span>Connect new...</span>
          </button>
        </div>
      </Field>
      <Field label="Max Turns" hint="limit agentic turns per headless run">
        <div className="max-turns-row">
          <input
            className="input"
            type="number"
            min={0}
            placeholder="default"
            value={form.maxTurns ?? ''}
            onChange={e => {
              const raw = e.target.value;
              onChange({ maxTurns: raw === '' ? undefined : Math.max(0, parseInt(raw, 10) || 0) });
            }}
          />
          <span className="max-turns-help">Để trống: mặc định (10) · Nhập <code>0</code>: không giới hạn</span>
        </div>
      </Field>
      <Field label="System Prompt">
        <textarea className="input" rows={6} placeholder="Describe the agent role and operating rules." value={form.systemPrompt} onChange={e => onChange({ systemPrompt: e.target.value })} />
      </Field>
    </div>
  </Modal>
  );
};
