import React from 'react';
import { Flow } from '@ai-stepflow/core/types';
import { Modal, Field } from '../components/primitives';

interface RunInputsModalProps {
  target: Flow | null;
  editing?: boolean;
  runName: string;
  values: Record<string, string>;
  error: string | null;
  onClose: () => void;
  onRunNameChange: (value: string) => void;
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
        <input
          className="input"
          placeholder="e.g. bug-fix-1"
          value={runName}
          onChange={e => onRunNameChange(e.target.value)}
        />
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
