import { useState, useEffect } from 'react';
import { Flow, Agent, Skill } from '@ai-stepflow/core/types';
import { isVSCodeWebview, sendToVSCode } from '../../vscode';
import { Tab, SaveScope, ScopeFilter, ViewFilter, SortOrder } from './types';
import { GroupBy } from '../../tagUtils';



export const useLibraryState = () => {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [flows, setFlows] = useState<Flow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);

  const [auditLogs, setAuditLogs] = useState<Record<string, any[]>>({});
  const [globalPath, setGlobalPath] = useState<string>('');
  const [projectPath, setProjectPath] = useState<string>('');
  const [connectedMcpServers, setConnectedMcpServers] = useState<string[]>([]);
  const [defaultLibraryInstalled, setDefaultLibraryInstalled] = useState<boolean>(false);
  const [recentWorkspaces, setRecentWorkspaces] = useState<{ path: string; name: string; lastOpenedMs: number }[]>([]);
  const [overviewScope, setOverviewScope] = useState<ScopeFilter>('all');
  const [runTotalsAll, setRunTotalsAll] = useState<{ runs: number; completed: number; inProgress: number; costUsd: number; tokensUsed: number; taskTimeMs: number; reviewTimeMs: number }>({ runs: 0, completed: 0, inProgress: 0, costUsd: 0, tokensUsed: 0, taskTimeMs: 0, reviewTimeMs: 0 });
  const [runTrendAll, setRunTrendAll] = useState<{ date: string; runs: number; completed: number; inProgress: number; costUsd: number; tokensUsed: number; taskTimeMs: number }[]>([]);
  const [runSummaries, setRunSummaries] = useState<{ flowId: string; runId: string; runName?: string; completedSteps: number; failedSteps?: number; totalSteps: number; mtimeMs: number; isClosed: boolean; costUsd?: number; tokensUsed?: number; taskTimeMs?: number; reviewTimeMs?: number }[]>([]);

  const [scopeFilters, setScopeFilters] = useState<{ flows: ScopeFilter; agents: ScopeFilter; skills: ScopeFilter }>({ flows: 'all', agents: 'all', skills: 'all' });
  const [viewFilters, setViewFilters] = useState<{ flows: ViewFilter; agents: ViewFilter; skills: ViewFilter }>({ flows: [], agents: [], skills: [] });
  const [sortOrders, setSortOrders] = useState<{ flows: SortOrder; agents: SortOrder; skills: SortOrder }>({ flows: 'activity', agents: 'activity', skills: 'activity' });
  const [groupBys, setGroupBys] = useState<{ agents: GroupBy; skills: GroupBy }>({ agents: 'list', skills: 'list' });

  const [detailItem, setDetailItem] = useState<{
    type: 'Flow' | 'Agent' | 'Skill';
    title: string;
    description: string;
    sourcePath: string;
    meta: Record<string, string | number>;
    onDelete: () => void;
  } | null>(null);



  const getItemScope = (sourcePath: string): SaveScope => {
    if (globalPath && sourcePath.startsWith(globalPath)) return 'global';
    return 'project';
  };

  const getFlowScope = (flow: Flow): SaveScope => getItemScope(flow.sourcePath);
  const getAgentByName = (name: string) => agents.find(agent => agent.name === name);
  const getSkillByName = (name: string) => skills.find(skill => skill.name === name);
  


  return {
    activeTab, setActiveTab,
    flows, setFlows,
    agents, setAgents,
    skills, setSkills,

    auditLogs, setAuditLogs,
    globalPath, setGlobalPath,
    projectPath, setProjectPath,
    connectedMcpServers, setConnectedMcpServers,
    defaultLibraryInstalled, setDefaultLibraryInstalled,
    recentWorkspaces, setRecentWorkspaces,
    overviewScope, setOverviewScope,
    runTotalsAll, setRunTotalsAll,
    runTrendAll, setRunTrendAll,
    runSummaries, setRunSummaries,
    scopeFilters, setScopeFilters,
    groupBys, setGroupBys,
    viewFilters, setViewFilters,
    sortOrders, setSortOrders,
    detailItem, setDetailItem,
    getItemScope, getFlowScope, getAgentByName, getSkillByName
  };
};
