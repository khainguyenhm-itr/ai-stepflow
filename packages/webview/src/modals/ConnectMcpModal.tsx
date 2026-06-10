import React, { useState } from 'react';
import { Modal, Field, Icon } from '../components/primitives';
import { SaveScope, SaveScopeSelect } from '../components/ScopeControls';

interface ConnectMcpModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (config: {
    name: string;
    scope: 'global' | 'local';
    command: string;
    args: string[];
    env?: Record<string, string>;
  }) => void;
}

export const ConnectMcpModal: React.FC<ConnectMcpModalProps> = ({
  open,
  onClose,
  onSubmit
}) => {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<SaveScope>('project');
  const [command, setCommand] = useState('');
  const [argsStr, setArgsStr] = useState('');
  const [envPairs, setEnvPairs] = useState<{ key: string; value: string }[]>([]);

  const addEnv = () => setEnvPairs([...envPairs, { key: '', value: '' }]);
  const updateEnv = (index: number, patch: Partial<{ key: string; value: string }>) => {
    const next = [...envPairs];
    next[index] = { ...next[index], ...patch };
    setEnvPairs(next);
  };
  const removeEnv = (index: number) => setEnvPairs(envPairs.filter((_, i) => i !== index));

  const handleSub = () => {
    if (!name.trim() || !command.trim()) return;
    const env: Record<string, string> = {};
    for (const p of envPairs) {
      if (p.key.trim()) env[p.key.trim()] = p.value;
    }
    onSubmit({
      name: name.trim(),
      scope: scope === 'global' ? 'global' : 'local',
      command: command.trim(),
      args: argsStr.split(/\s+/).filter(Boolean),
      env: Object.keys(env).length > 0 ? env : undefined
    });
    // Reset form
    setName('');
    setCommand('');
    setArgsStr('');
    setEnvPairs([]);
  };

  const setPreset = (type: 'github' | 'figma') => {
    if (type === 'github') {
      setName('github');
      setCommand('npx');
      setArgsStr('-y @modelcontextprotocol/server-github');
      if (!envPairs.some(p => p.key === 'GITHUB_PERSONAL_ACCESS_TOKEN')) {
        setEnvPairs([...envPairs, { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: '' }]);
      }
    } else if (type === 'figma') {
      setName('figma');
      setCommand('npx');
      setArgsStr('-y @modelcontextprotocol/server-figma');
      if (!envPairs.some(p => p.key === 'FIGMA_ACCESS_TOKEN')) {
        setEnvPairs([...envPairs, { key: 'FIGMA_ACCESS_TOKEN', value: '' }]);
      }
    }
  };

  return (
    <Modal
      title="Connect MCP Server"
      open={open}
      onClose={onClose}
      width={480}
      footer={(
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim() || !command.trim()} onClick={handleSub}>Connect</button>
        </>
      )}
    >
      <div className="stack">
        <div className="field-group">
          <label className="label">Presets</label>
          <div className="flex-row gap-8">
            <button className="btn small" onClick={() => setPreset('github')}>GitHub</button>
            <button className="btn small" onClick={() => setPreset('figma')}>Figma</button>
          </div>
        </div>

        <Field label="Name">
          <input className="input" placeholder="github" value={name} onChange={e => setName(e.target.value)} />
        </Field>

        <Field label="Scope">
          <SaveScopeSelect value={scope} onChange={setScope} />
        </Field>

        <Field label="Command">
          <input className="input" placeholder="npx" value={command} onChange={e => setCommand(e.target.value)} />
        </Field>

        <Field label="Arguments" hint="space-separated">
          <input className="input" placeholder="-y @modelcontextprotocol/server-github" value={argsStr} onChange={e => setArgsStr(e.target.value)} />
        </Field>

        <div className="field-group">
          <div className="flex-row justify-between items-center mb-4">
            <label className="label">Environment Variables</label>
            <button className="icon-btn" onClick={addEnv} title="Add variable"><Icon.Plus size={14} /></button>
          </div>
          <div className="stack gap-4">
            {envPairs.map((pair, i) => (
              <div key={i} className="flex-row gap-4 items-center">
                <input className="input" style={{ flex: 1 }} placeholder="KEY" value={pair.key} onChange={e => updateEnv(i, { key: e.target.value })} />
                <input className="input" style={{ flex: 1 }} placeholder="VALUE" type="password" value={pair.value} onChange={e => updateEnv(i, { value: e.target.value })} />
                <button className="icon-btn danger" onClick={() => removeEnv(i)}><Icon.X size={14} /></button>
              </div>
            ))}
            {envPairs.length === 0 && <div className="muted small">No environment variables added.</div>}
          </div>
        </div>
      </div>
    </Modal>
  );
};
