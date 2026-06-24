import { useState, useEffect } from 'react';
import { Flow, Agent, Skill } from '@ai-stepflow/core/types';
import { Tab, SaveScope, ScopeFilter, ViewFilter, SortOrder } from './types';

const BOOKMARKS_STORAGE_KEY = 'ai-stepflow:resource-bookmarks';

type ResourceBookmarks = Record<string, boolean>;

const loadBookmarks = (): ResourceBookmarks => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(BOOKMARKS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export const useLibraryState = () => {
  const [activeTab, setActiveTab] = useState<Tab>('flows');
  const [flows, setFlows] = useState<Flow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [bookmarks, setBookmarks] = useState<ResourceBookmarks>(loadBookmarks);
  const [auditLogs, setAuditLogs] = useState<Record<string, any[]>>({});
  const [globalPath, setGlobalPath] = useState<string>('');
  const [projectPath, setProjectPath] = useState<string>('');
  const [connectedMcpServers, setConnectedMcpServers] = useState<string[]>([]);
  const [runSummaries, setRunSummaries] = useState<{ flowId: string; runId: string; runName?: string; completedSteps: number; totalSteps: number; mtimeMs: number; isClosed: boolean }[]>([]);

  const [scopeFilters, setScopeFilters] = useState<{ flows: ScopeFilter; agents: ScopeFilter; skills: ScopeFilter }>({ flows: 'all', agents: 'all', skills: 'all' });
  const [viewFilters, setViewFilters] = useState<{ flows: ViewFilter; agents: ViewFilter; skills: ViewFilter }>({ flows: [], agents: [], skills: [] });
  const [sortOrders, setSortOrders] = useState<{ flows: SortOrder; agents: SortOrder; skills: SortOrder }>({ flows: 'asc', agents: 'asc', skills: 'asc' });

  const [detailItem, setDetailItem] = useState<{
    type: 'Flow' | 'Agent' | 'Skill';
    title: string;
    description: string;
    sourcePath: string;
    meta: Record<string, string | number>;
    onDelete: () => void;
  } | null>(null);

  useEffect(() => {
    window.localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(bookmarks));
  }, [bookmarks]);

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
    viewFilters, setViewFilters,
    sortOrders, setSortOrders,
    detailItem, setDetailItem,
    getItemScope, getFlowScope, getAgentByName, getSkillByName,
    isBookmarked, toggleBookmark
  };
};
