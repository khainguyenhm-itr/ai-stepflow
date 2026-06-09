import React from 'react';
import { Agent, Skill } from '@ai-stepflow/core/types';
import { Modal } from '../components/primitives';

interface StandaloneRunModalProps {
  run: { type: 'agent'; agent: Agent } | { type: 'skill'; skill: Skill } | null;
  description: string;
  onClose: () => void;
  onDescriptionChange: (value: string) => void;
  onSubmit: () => void;
}

export const StandaloneRunModal: React.FC<StandaloneRunModalProps> = ({
  run,
  description,
  onClose,
  onDescriptionChange,
  onSubmit
}) => (
  <Modal
    title={run ? `Run ${run.type === 'agent' ? run.agent.name : run.skill.name}` : 'Run'}
    open={!!run}
    onClose={onClose}
    width={520}
    footer={(
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={onSubmit}>Run</button>
      </>
    )}
  >
    <div className="stack">
      <p className="muted">
        {run?.type === 'agent' ? 'Run this agent directly in the VS Code terminal.' : 'Run this skill directly in the VS Code terminal.'}
      </p>
      <textarea
        className="input"
        rows={5}
        value={description}
        onChange={event => onDescriptionChange(event.target.value)}
        placeholder="Describe what Claude should do for this run."
      />
    </div>
  </Modal>
);
