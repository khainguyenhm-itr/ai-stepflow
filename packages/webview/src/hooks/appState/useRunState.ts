import { useState, useRef, useEffect } from 'react';
import { Flow, FlowRunState, Agent, Skill } from '@ai-stepflow/core/types';

export const useRunState = () => {
  const [activeFlow, setActiveFlow] = useState<Flow | null>(null);
  const [runState, setRunState] = useState<FlowRunState | null>(null);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [runnerVisible, setRunnerVisible] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);

  const [standaloneRun, setStandaloneRun] = useState<{ type: 'agent'; agent: Agent } | { type: 'skill'; skill: Skill } | null>(null);
  const [standaloneRunDescription, setStandaloneRunDescription] = useState('');

  const [runInputsTarget, setRunInputsTarget] = useState<Flow | null>(null);
  const [runName, setRunName] = useState('');
  const [runInputValues, setRunInputValues] = useState<Record<string, string>>({});
  const [runInputsError, setRunInputsError] = useState<string | null>(null);

  const outputEndRef = useRef<HTMLDivElement>(null);
  const activeFlowRef = useRef<Flow | null>(null);
  const shouldPersistRun = useRef(false);

  useEffect(() => {
    activeFlowRef.current = activeFlow;
  }, [activeFlow]);

  return {
    activeFlow, setActiveFlow,
    runState, setRunState,
    activeStepId, setActiveStepId,
    runnerVisible, setRunnerVisible,
    commandCopied, setCommandCopied,
    standaloneRun, setStandaloneRun,
    standaloneRunDescription, setStandaloneRunDescription,
    runInputsTarget, setRunInputsTarget,
    runName, setRunName,
    runInputValues, setRunInputValues,
    runInputsError, setRunInputsError,
    outputEndRef,
    activeFlowRef,
    shouldPersistRun
  };
};
