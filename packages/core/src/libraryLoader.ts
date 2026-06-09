import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';
import { Agent, Flow, Skill } from './types.js';
import { formatFlowError, parseFlow } from './schema.js';

export interface LibraryLoadOptions {
  projectPath: string;
  globalPath?: string;
}

function scopedDirs(projectPath: string, globalPath: string, kind: 'agents' | 'skills' | 'flows'): string[] {
  return [path.join(globalPath, kind), path.join(projectPath, '.claude', kind)];
}

async function listFiles(dir: string, predicate: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && predicate(entry.name)).map(entry => entry.name);
  } catch {
    return [];
  }
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return [];
  }
}

async function parseAgentFile(filePath: string): Promise<Agent | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const leadingComments = content.match(/^(?:\s*<!--[\s\S]*?-->\s*)+(?=---(?:\r?\n|$))/);
    const parseableContent = leadingComments ? content.slice(leadingComments[0].length) : content;
    const { data, content: body } = matter(parseableContent);
    return {
      name: data.name || path.basename(filePath, '.md'),
      description: data.description || '',
      model: data.model || 'sonnet',
      tools: data.tools,
      systemPrompt: body.trim(),
      runnerPath: data.runner || data.runnerPath || undefined,
      sourcePath: filePath,
      builtIn: false
    };
  } catch (error) {
    console.error(`Error parsing agent file ${filePath}:`, error);
    return undefined;
  }
}

async function parseSkillFile(filePath: string, logMissing = true): Promise<Skill | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const leadingComments = content.match(/^(?:\s*<!--[\s\S]*?-->\s*)+(?=---(?:\r?\n|$))/);
    const parseableContent = leadingComments ? content.slice(leadingComments[0].length) : content;
    const { data, content: body } = matter(parseableContent);
    const fallbackName = path.basename(filePath).toUpperCase() === 'SKILL.MD'
      ? path.basename(path.dirname(filePath))
      : path.basename(filePath, '.md');
    return {
      name: data.name || fallbackName,
      description: data.description || '',
      instructions: body.trim(),
      sourcePath: filePath,
      builtIn: false
    };
  } catch (error: any) {
    if (logMissing || error?.code !== 'ENOENT') {
      console.error(`Error parsing skill file ${filePath}:`, error);
    }
    return undefined;
  }
}

async function parseFlowFile(filePath: string): Promise<Flow | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const data = parseYaml(content);
    const fallbackId = path.basename(filePath, path.extname(filePath));
    return parseFlow(data, fallbackId, filePath);
  } catch (error) {
    console.error(`Error parsing flow file ${filePath}: ${formatFlowError(error)}`);
    return undefined;
  }
}

export async function loadAgents(opts: LibraryLoadOptions): Promise<Agent[]> {
  const globalPath = opts.globalPath ?? path.join(os.homedir(), '.claude');
  const agents = new Map<string, Agent>();
  for (const dir of scopedDirs(opts.projectPath, globalPath, 'agents')) {
    for (const file of await listFiles(dir, name => name.endsWith('.md'))) {
      const agent = await parseAgentFile(path.join(dir, file));
      if (agent) agents.set(agent.name, agent);
    }
  }
  return Array.from(agents.values());
}

export async function loadSkills(opts: LibraryLoadOptions): Promise<Skill[]> {
  const globalPath = opts.globalPath ?? path.join(os.homedir(), '.claude');
  const skills = new Map<string, Skill>();
  for (const dir of scopedDirs(opts.projectPath, globalPath, 'skills')) {
    for (const file of await listFiles(dir, name => name.endsWith('.md'))) {
      const skill = await parseSkillFile(path.join(dir, file), true);
      if (skill) skills.set(skill.name, skill);
    }
    for (const subdir of await listDirectories(dir)) {
      const skill = await parseSkillFile(path.join(dir, subdir, 'SKILL.md'), false);
      if (skill) skills.set(skill.name, skill);
    }
  }
  return Array.from(skills.values());
}

export async function loadFlows(opts: LibraryLoadOptions): Promise<Flow[]> {
  const globalPath = opts.globalPath ?? path.join(os.homedir(), '.claude');
  const flows = new Map<string, Flow>();
  for (const dir of scopedDirs(opts.projectPath, globalPath, 'flows')) {
    for (const file of await listFiles(dir, name => name.endsWith('.yaml') || name.endsWith('.yml'))) {
      const flow = await parseFlowFile(path.join(dir, file));
      if (flow) flows.set(flow.id, flow);
    }
  }
  return Array.from(flows.values());
}

export async function loadFlowByIdOrPath(opts: LibraryLoadOptions & { flowRef: string }): Promise<Flow | undefined> {
  if (path.isAbsolute(opts.flowRef) || opts.flowRef.includes(path.sep)) {
    return parseFlowFile(path.resolve(opts.flowRef));
  }
  const flows = await loadFlows(opts);
  return flows.find(flow => flow.id === opts.flowRef || flow.name === opts.flowRef);
}
