export type Tab = 'flows' | 'agents' | 'skills';
export type SaveScope = 'project' | 'global';
export type FlowAiMessage = { role: 'user' | 'assistant'; content: string };
export type ScopeFilter = 'all' | 'project' | 'global';
export type ViewFilterItem = 'bookmarked' | 'built-in';
export type ViewFilter = ReadonlyArray<ViewFilterItem>;
export type SortOrder = 'asc' | 'desc';
