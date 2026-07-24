import React from 'react';
import { Flow } from '@claudesteps/core/types';
import { Modal, Field } from '../components/primitives';

interface RunInputsModalProps {
  target: Flow | null;
  editing?: boolean;
  runName: string;
  values: Record<string, string>;
  error: string | null;
  onClose: () => void;
  onRunNameChange: (value: string) => void;
  onGenerateName: () => void;
  onValueChange: (name: string, value: string) => void;
  onSubmit: () => void;
}

export const RunInputsModal: React.FC<RunInputsModalProps> = ({
  target,
  editing = false,
  runName,
  values,
  error,
  onClose,
  onRunNameChange,
  onGenerateName,
  onValueChange,
  onSubmit
}) => (
  <Modal
    title={target ? `${editing ? 'Edit run' : 'New run'}: ${target.name}` : (editing ? 'Edit run' : 'New run')}
    open={!!target}
    onClose={onClose}
    width={480}
    footer={(
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={onSubmit}>{editing ? 'Save Changes' : 'Start Independent Run'}</button>
      </>
    )}
  >
    <div className="stack">
      {error && <div className="error-banner">{error}</div>}
      <Field label="Run Name (optional)" hint="Name this run to distinguish it in history (e.g. fix-bug-1).">
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="e.g. bug-fix-1"
            value={runName}
            onChange={e => onRunNameChange(e.target.value)}
          />
          <button className="btn" type="button" title="Auto-generate a name from the workflow name" onClick={onGenerateName}>Auto</button>
        </div>
      </Field>
      {target && Object.entries(target.inputs || {}).map(([name, def]) => (
        <Field key={name} label={`${def.label || name}${def.required ? ' *' : ''}`}>
          <input
            className="input"
            value={values[name] || ''}
            onChange={e => onValueChange(name, e.target.value)}
          />
        </Field>
      ))}
    </div>
  </Modal>
);
