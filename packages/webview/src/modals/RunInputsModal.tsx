import React from 'react';
import { Flow } from '@ai-stepflow/core/types';
import { Modal, Field } from '../components/primitives';

interface RunInputsModalProps {
  target: Flow | null;
  values: Record<string, string>;
  error: string | null;
  onClose: () => void;
  onValueChange: (name: string, value: string) => void;
  onSubmit: () => void;
}

export const RunInputsModal: React.FC<RunInputsModalProps> = ({
  target,
  values,
  error,
  onClose,
  onValueChange,
  onSubmit
}) => (
  <Modal
    title={target ? `Start run: ${target.name}` : 'Start run'}
    open={!!target}
    onClose={onClose}
    width={480}
    footer={(
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={onSubmit}>Start run</button>
      </>
    )}
  >
    <div className="stack">
      {error && <div className="error-banner">{error}</div>}
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
