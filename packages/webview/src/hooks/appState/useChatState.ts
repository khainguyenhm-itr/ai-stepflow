import { useState } from 'react';
import { FlowAiMessage } from './types';

export const useChatState = () => {
  const [flowAiPrompt, setFlowAiPrompt] = useState('');
  const [flowAiMessages, setFlowAiMessages] = useState<FlowAiMessage[]>([]);
  const [flowAiLoading, setFlowAiLoading] = useState(false);

  const [agentAiPrompt, setAgentAiPrompt] = useState('');
  const [agentAiMessages, setAgentAiMessages] = useState<FlowAiMessage[]>([]);
  
  const [skillAiPrompt, setSkillAiPrompt] = useState('');
  const [skillAiMessages, setSkillAiMessages] = useState<FlowAiMessage[]>([]);

  return {
    flowAiPrompt, setFlowAiPrompt,
    flowAiMessages, setFlowAiMessages,
    flowAiLoading, setFlowAiLoading,
    agentAiPrompt, setAgentAiPrompt,
    agentAiMessages, setAgentAiMessages,
    skillAiPrompt, setSkillAiPrompt,
    skillAiMessages, setSkillAiMessages
  };
};
