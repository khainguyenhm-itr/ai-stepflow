export type Tab = 'overview' | 'flows' | 'agents' | 'skills';
export type SaveScope = 'project' | 'global';
export type FlowAiMessage = { role: 'user' | 'assistant'; content: string };
export type ScopeFilter = 'all' | 'project' | 'global';
export type ViewFilterItem = 'built-in';
export type ViewFilter = ReadonlyArray<ViewFilterItem>;
export type SortOrder = 'activity' | 'asc' | 'desc' | 'newest' | 'oldest';
