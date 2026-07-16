import { useState, useRef, useEffect } from 'react';
import { Flow, FlowRunState, Agent, Skill } from '@ai-stepflow/core/types';

export const useRunState = () => {
  const [activeFlow, setActiveFlow] = useState<Flow | null>(null);
  const [runState, setRunState] = useState<FlowRunState | null>(null);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [runnerVisible, setRunnerVisible] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  // Sidebar "Open runs" signal: expand + scroll to a run detail. nonce re-triggers on repeat opens.
  const [revealRun, setRevealRun] = useState<{ flowId: string; runId: string; nonce: number } | null>(null);

  const [standaloneRun, setStandaloneRun] = useState<{ type: 'agent'; agent: Agent } | { type: 'skill'; skill: Skill } | null>(null);
  const [standaloneRunDescription, setStandaloneRunDescription] = useState('');

  const [runInputsTarget, setRunInputsTarget] = useState<Flow | null>(null);
  const [runInputsEditing, setRunInputsEditing] = useState(false);
  const [runName, setRunName] = useState('');
  const [runInputValues, setRunInputValues] = useState<Record<string, string>>({});
  const [runInputsError, setRunInputsError] = useState<string | null>(null);

  const outputEndRef = useRef<HTMLDivElement>(null);
  const activeFlowRef = useRef<Flow | null>(null);
  /** Always-current runId of the focused run, so message handlers can gate per-run updates without
   *  relying on the (closure-stale) runState value. Mirrors runState.runId. */
  const activeRunIdRef = useRef<string | null>(null);
  const shouldPersistRun = useRef(false);

  useEffect(() => {
    activeFlowRef.current = activeFlow;
  }, [activeFlow]);

  useEffect(() => {
    activeRunIdRef.current = runState?.runId ?? null;
  }, [runState]);

  return {
    activeFlow, setActiveFlow,
    runState, setRunState,
    activeStepId, setActiveStepId,
    runnerVisible, setRunnerVisible,
    commandCopied, setCommandCopied,
    revealRun, setRevealRun,
    standaloneRun, setStandaloneRun,
    standaloneRunDescription, setStandaloneRunDescription,
    runInputsTarget, setRunInputsTarget,
    runInputsEditing, setRunInputsEditing,
    runName, setRunName,
    runInputValues, setRunInputValues,
    runInputsError, setRunInputsError,
    outputEndRef,
    activeFlowRef,
    activeRunIdRef,
    shouldPersistRun
  };
};
