import { useState, useEffect } from 'react';
import { Flow, Agent, Skill } from '@ai-stepflow/core/types';
import { isVSCodeWebview, sendToVSCode } from '../../vscode';
import { Tab, SaveScope, ScopeFilter, ViewFilter, SortOrder } from './types';
import { GroupBy } from '../../tagUtils';

type ResourceBookmarks = Record<string, boolean>;

export const useLibraryState = () => {
  const [activeTab, setActiveTab] = useState<Tab>('flows');
  const [flows, setFlows] = useState<Flow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [bookmarks, setBookmarks] = useState<ResourceBookmarks>({});
  const [auditLogs, setAuditLogs] = useState<Record<string, any[]>>({});
  const [globalPath, setGlobalPath] = useState<string>('');
  const [projectPath, setProjectPath] = useState<string>('');
  const [connectedMcpServers, setConnectedMcpServers] = useState<string[]>([]);
  const [runSummaries, setRunSummaries] = useState<{ flowId: string; runId: string; runName?: string; completedSteps: number; totalSteps: number; mtimeMs: number; isClosed: boolean }[]>([]);

  const [scopeFilters, setScopeFilters] = useState<{ flows: ScopeFilter; agents: ScopeFilter; skills: ScopeFilter }>({ flows: 'all', agents: 'all', skills: 'all' });
  const [viewFilters, setViewFilters] = useState<{ flows: ViewFilter; agents: ViewFilter; skills: ViewFilter }>({ flows: [], agents: [], skills: [] });
  const [sortOrders, setSortOrders] = useState<{ flows: SortOrder; agents: SortOrder; skills: SortOrder }>({ flows: 'asc', agents: 'asc', skills: 'asc' });
  const [groupBys, setGroupBys] = useState<{ agents: GroupBy; skills: GroupBy }>({ agents: 'list', skills: 'list' });

  const [detailItem, setDetailItem] = useState<{
    type: 'Flow' | 'Agent' | 'Skill';
    title: string;
    description: string;
    sourcePath: string;
    meta: Record<string, string | number>;
    onDelete: () => void;
  } | null>(null);

  useEffect(() => {
    if (!projectPath) return; // wait until loadData sets projectPath before persisting
    if (isVSCodeWebview()) {
      sendToVSCode('savePref', { key: 'bookmarks', value: JSON.stringify(bookmarks) });
    } else {
      try { window.localStorage.setItem('ai-stepflow:resource-bookmarks', JSON.stringify(bookmarks)); } catch (_e) { /* ignore */ }
    }
  }, [bookmarks, projectPath]);

  const getItemScope = (sourcePath: string): SaveScope => {
    if (globalPath && sourcePath.startsWith(globalPath)) return 'global';
    return 'project';
  };

  const getFlowScope = (flow: Flow): SaveScope => getItemScope(flow.sourcePath);
  const getAgentByName = (name: string) => agents.find(agent => agent.name === name);
  const getSkillByName = (name: string) => skills.find(skill => skill.name === name);
  
  const getBookmarkKey = (kind: 'agent' | 'skill' | 'flow', sourcePath: string) => `${kind}:${sourcePath}`;
  const isBookmarked = (kind: 'agent' | 'skill' | 'flow', sourcePath: string) => !!bookmarks[getBookmarkKey(kind, sourcePath)];
  const toggleBookmark = (kind: 'agent' | 'skill' | 'flow', sourcePath: string) => {
    const key = getBookmarkKey(kind, sourcePath);
    setBookmarks(prev => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  };

  return {
    activeTab, setActiveTab,
    flows, setFlows,
    agents, setAgents,
    skills, setSkills,
    bookmarks, setBookmarks,
    auditLogs, setAuditLogs,
    globalPath, setGlobalPath,
    projectPath, setProjectPath,
    connectedMcpServers, setConnectedMcpServers,
    runSummaries, setRunSummaries,
    scopeFilters, setScopeFilters,
    groupBys, setGroupBys,
    viewFilters, setViewFilters,
    sortOrders, setSortOrders,
    detailItem, setDetailItem,
    getItemScope, getFlowScope, getAgentByName, getSkillByName,
    isBookmarked, toggleBookmark
  };
};
