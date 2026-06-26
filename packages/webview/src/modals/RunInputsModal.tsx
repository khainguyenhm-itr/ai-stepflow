import React from 'react';
import { Flow } from '@ai-stepflow/core/types';
import { Modal, Field } from '../components/primitives';

interface RunInputsModalProps {
  target: Flow | null;
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
  runName,
  values,
  error,
  onClose,
  onRunNameChange,
  onValueChange,
  onSubmit
}) => (
  <Modal
    title={target ? `New run: ${target.name}` : 'New run'}
    open={!!target}
    onClose={onClose}
    width={480}
    footer={(
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={onSubmit}>Start Independent Run</button>
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
