import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { parse, parseDocument, Document, isMap } from 'yaml';
import matter from 'gray-matter';
import { Agent, Skill, Flow, parseFlow, formatFlowError, AgentInput, SkillInput } from '@ai-stepflow/core';

export type BundledKind = 'agents' | 'skills' | 'reviews' | 'validators';

export class ConfigManager {
  private readonly globalPath: string;
  /** Marker stamped on every file this extension installs, so updates never clobber user-authored files. */
  private static readonly BUILT_IN_MARKER = 'ai-stepflow built-in';
  /** Markers wrapping the block we merge into a project's CLAUDE.md, so it can be removed cleanly on uninstall. */
  private static readonly CLAUDE_MD_START = '<!-- ai-stepflow:karpathy:start -->';
  private static readonly CLAUDE_MD_END = '<!-- ai-stepflow:karpathy:end -->';

  constructor(private readonly extensionPath?: string) {
    this.globalPath = path.join(os.homedir(), '.claude');
  }

  /**
   * Install the bundled default library (SDLC agents + skills + karpathy) into ~/.claude or project .claude.
   * NOT run automatically — the user opts in via the sidebar "Initialize" button, and can
   * re-run it to repair corrupted/edited default files. Idempotent and marker-guarded.
   */
  public async installDefaultLibrary(isGlobal: boolean = true): Promise<void> {
    await this.installBundledDefaults(isGlobal);
    // The Karpathy discipline now lives in the global CLAUDE.md (no separate global skill);
    // remove the legacy global skill we used to install, then merge the rules (idempotent).
    if (isGlobal) {
      await this.removeLegacyKarpathySkill();
      await this.ensureGlobalClaudeMd();
    }
  }

  /** Remove the old global ~/.claude/skills/karpathy skill (superseded by the CLAUDE.md merge). */
  private async removeLegacyKarpathySkill(): Promise<void> {
    const skillDir = path.join(this.globalPath, 'skills', 'karpathy');
    try {
      const content = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
      if (content.includes(ConfigManager.BUILT_IN_MARKER)) {
        await fs.rm(skillDir, { recursive: true, force: true });
      }
    } catch { /* not present — nothing to remove */ }
  }

  /** Returns every bundled default item with name, description, and whether it is installed. */
  public async listBundledDefaults(): Promise<Array<{ kind: BundledKind; filename: string; name: string; description: string; installed: boolean }>> {
    if (!this.extensionPath) return [];
    const result: Array<{ kind: BundledKind; filename: string; name: string; description: string; installed: boolean }> = [];
    const KINDS: Array<{ kind: BundledKind; exts: string[] }> = [
      { kind: 'agents', exts: ['.md'] },
      { kind: 'skills', exts: ['.md'] },
      { kind: 'reviews', exts: ['.md'] },
      { kind: 'validators', exts: ['.mjs', '.js'] },
    ];
    for (const { kind, exts } of KINDS) {
      const srcDir = path.join(this.extensionPath, 'resources', 'defaults', kind);
      let files: string[];
      try {
        files = (await fs.readdir(srcDir)).filter(n => exts.some(e => n.endsWith(e)));
      } catch { continue; }
      for (const filename of files) {
        try {
          const content = await fs.readFile(path.join(srcDir, filename), 'utf8');
          const installed = await this._isBundledItemInstalled(kind, filename);
          let name: string, description: string;
          if (filename.endsWith('.md')) {
            const leadingComments = content.match(/^(?:\s*<!--[\s\S]*?-->\s*)+(?=---(?:\r?\n|$))/);
            const parseableContent = leadingComments ? content.slice(leadingComments[0].length) : content;
            const m = matter(parseableContent);
            name = String(m.data.name || filename.replace('.md', ''));
            description = String(m.data.description || this._firstHeading(content) || '');
          } else {
            name = filename.replace(/\.(mjs|js)$/, '');
            description = this._firstJsComment(content);
          }
          result.push({ kind, filename, name, description, installed });
        } catch { /* skip */ }
      }
    }
    return result;
  }

  private _firstHeading(md: string): string {
    const m = md.match(/^#{1,2}\s+(.+)/m);
    return m ? m[1].trim() : '';
  }

  private _firstJsComment(js: string): string {
    for (const line of js.split('\n')) {
      const m = line.match(/^\/\/\s*(.+)/);
      if (!m) continue;
      const text = m[1].trim();
      if (text.toLowerCase().startsWith('ai-stepflow')) continue;
      return text;
    }
    return '';
  }

  private async _isBundledItemInstalled(kind: BundledKind, filename: string): Promise<boolean> {
    const roots = [this.globalPath];
    if (this.projectPath) roots.push(path.join(this.projectPath, '.claude'));
    for (const base of roots) {
      try {
        const content = await fs.readFile(path.join(base, kind, filename), 'utf8');
        if (content.includes(ConfigManager.BUILT_IN_MARKER)) return true;
      } catch { /* not present */ }
    }
    return false;
  }

  /** Install a single bundled default item to global or project scope. */
  public async installBundledItem(kind: BundledKind, filename: string, isGlobal: boolean = true): Promise<void> {
    if (!this.extensionPath) return;
    const srcPath = path.join(this.extensionPath, 'resources', 'defaults', kind, filename);
    const targetBase = isGlobal ? this.globalPath : path.join(this.projectPath || '', '.claude');
    if (!isGlobal && !this.projectPath) return;
    const destPath = path.join(targetBase, kind, filename);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const existing = await fs.readFile(destPath, 'utf8').catch(() => undefined);
    if (existing !== undefined && !existing.includes(ConfigManager.BUILT_IN_MARKER)) return;
    const content = await fs.readFile(srcPath, 'utf8');
    await fs.writeFile(destPath, content, 'utf8');
  }

  /** Remove a single bundled default item from all scopes (only files we installed). */
  public async uninstallBundledItem(kind: BundledKind, filename: string): Promise<void> {
    const roots = [this.globalPath];
    if (this.projectPath) roots.push(path.join(this.projectPath, '.claude'));
    for (const base of roots) {
      const destPath = path.join(base, kind, filename);
      try {
        const content = await fs.readFile(destPath, 'utf8');
        if (content.includes(ConfigManager.BUILT_IN_MARKER)) await fs.unlink(destPath);
      } catch { /* not present */ }
    }
  }

  /** True if any of our marker-stamped default files are present in the given scope. */
  public async isDefaultLibraryInstalled(scope: 'global' | 'project' = 'global'): Promise<boolean> {
    const targetBase = scope === 'global' ? this.globalPath : path.join(this.projectPath || '', '.claude');
    if (scope === 'project' && !this.projectPath) return false;

    for (const kind of ['agents', 'skills'] as const) {
      const dir = path.join(targetBase, kind);
      let files: string[];
      try {
        files = (await fs.readdir(dir)).filter(n => n.endsWith('.md'));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          if ((await fs.readFile(path.join(dir, f), 'utf8')).includes(ConfigManager.BUILT_IN_MARKER)) return true;
        } catch { /* ignore */ }
      }
    }
    return false;
  }

  /**
   * Merge the Karpathy engineering rules into the global ~/.claude/CLAUDE.md, wrapped in markers.
   * Idempotent.
   */
  public async ensureGlobalClaudeMd(): Promise<void> {
    const claudeMdPath = path.join(this.globalPath, 'CLAUDE.md');
    const block = [
      ConfigManager.CLAUDE_MD_START,
      '## Engineering Discipline (Karpathy Rules)',
      '- **Think Before Coding**: State assumptions and tradeoffs explicitly before implementation.',
      '- **Simplicity First**: Bias toward minimum code. No speculative features or over-engineering.',
      '- **Surgical Changes**: Only modify files and lines strictly necessary. No unrelated refactors.',
      '- **Goal-Driven**: Fulfill success criteria and ensure results are verifiable.',
      ConfigManager.CLAUDE_MD_END
    ].join('\n');

    try {
      const exists = await fs.access(claudeMdPath).then(() => true).catch(() => false);
      if (!exists) {
        await fs.writeFile(claudeMdPath, `# Global Guidelines\n\n${block}\n`, 'utf8');
      } else {
        const content = await fs.readFile(claudeMdPath, 'utf8');
        // Skip if already merged (marked) or if a pre-marker version of the section is present.
        if (content.includes(ConfigManager.CLAUDE_MD_START) || content.includes('Engineering Discipline (Karpathy Rules)')) return;
        await fs.appendFile(claudeMdPath, `\n${block}\n`, 'utf8');
      }
    } catch (e) {
      console.error('AI StepFlow: failed to initialize global CLAUDE.md', e);
    }
  }

  /** Resolved lazily so workspace folder changes are always picked up. */
  public get projectPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * Copy the bundled `resources/defaults/{agents,skills}` markdown into the target library.
   * Idempotent: a target is (re)written only when it is missing or was
   * installed by us (carries {@link BUILT_IN_MARKER}); a user-authored file is left untouched.
   */
  private async installBundledDefaults(isGlobal: boolean): Promise<void> {
    if (!this.extensionPath) return;
    // `validators` are deterministic review modules (.mjs) steps can point `validatorPath` at;
    // they carry the same built-in marker (as a JS comment) so the overwrite rules still apply.
    const sources: { kind: string; exts: string[] }[] = [
      { kind: 'agents', exts: ['.md'] },
      { kind: 'skills', exts: ['.md'] },
      { kind: 'validators', exts: ['.mjs', '.js'] },
      { kind: 'reviews', exts: ['.md'] }
    ];
    const targetBase = isGlobal ? this.globalPath : path.join(this.projectPath || '', '.claude');
    if (!isGlobal && !this.projectPath) return;

    // Record where we installed so the uninstall hook (which has no workspace context) can
    // clean project-scoped installs too, not just ~/.claude.
    await this.recordInstallRoot(targetBase);

    for (const { kind, exts } of sources) {
      const srcDir = path.join(this.extensionPath, 'resources', 'defaults', kind);
      const destDir = path.join(targetBase, kind);
      let files: string[];
      try {
        files = (await fs.readdir(srcDir)).filter(name => exts.some(ext => name.endsWith(ext)));
      } catch {
        continue; // bundle missing (e.g. dev run without resources) — nothing to install
      }
      await fs.mkdir(destDir, { recursive: true });
      for (const file of files) {
        const destPath = path.join(destDir, file);
        try {
          const existing = await fs.readFile(destPath, 'utf8').catch(() => undefined);
          if (existing !== undefined && !existing.includes(ConfigManager.BUILT_IN_MARKER)) {
            continue; // user took ownership of this name — never overwrite it
          }
          const content = await fs.readFile(path.join(srcDir, file), 'utf8');
          await fs.writeFile(destPath, content, 'utf8');
        } catch (e) {
          console.error(`AI StepFlow: failed to install bundled ${kind} ${file}`, e);
        }
      }
      await this.pruneRenamedDefaults(destDir, new Set(files), exts);
    }
  }

  /** Append a `.claude` root we installed into, to the manifest the uninstall hook reads. */
  private async recordInstallRoot(root: string): Promise<void> {
    const trackPath = path.join(this.globalPath, '.ai-stepflow', 'installed-roots.json');
    try {
      await fs.mkdir(path.dirname(trackPath), { recursive: true });
      let roots: string[] = [];
      try { roots = JSON.parse(await fs.readFile(trackPath, 'utf8')); } catch { /* none yet */ }
      if (!Array.isArray(roots)) roots = [];
      if (!roots.includes(root)) {
        roots.push(root);
        await fs.writeFile(trackPath, JSON.stringify(roots, null, 2), 'utf8');
      }
    } catch (e) {
      console.error('AI StepFlow: failed to record install root', e);
    }
  }

  /**
   * Remove our previously-installed defaults whose filenames are no longer in the bundle
   * (e.g. after the `aisf-` rename) so renaming a default never leaves a stale duplicate.
   * Only files carrying {@link BUILT_IN_MARKER} are touched — user files are never removed.
   */
  private async pruneRenamedDefaults(destDir: string, currentBundle: Set<string>, exts: string[] = ['.md']): Promise<void> {
    let existing: string[];
    try {
      existing = (await fs.readdir(destDir)).filter(name => exts.some(ext => name.endsWith(ext)));
    } catch {
      return;
    }
    for (const file of existing) {
      if (currentBundle.has(file)) continue;
      const filePath = path.join(destDir, file);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        if (content.includes(ConfigManager.BUILT_IN_MARKER)) {
          await fs.rm(filePath, { force: true });
        }
      } catch { /* ignore unreadable entries */ }
    }
  }

  public async loadAgents(): Promise<Agent[]> {
    const agents = new Map<string, Agent>();
    console.log('AI StepFlow: loadAgents starting...');

    for (const dir of this.scopedDirs('agents')) {
      const files = await this.listFiles(dir, name => name.endsWith('.md'));
      console.log(`AI StepFlow: checking dir ${dir}, found ${files.length} md files.`);
      for (const file of files) {
        const agent = await this.parseAgentFile(path.join(dir, file));
        if (agent) agents.set(agent.name, agent);
      }
    }

    console.log(`AI StepFlow: loadAgents finished, total ${agents.size} unique agents.`);
    return Array.from(agents.values());
  }

  public async loadSkills(): Promise<Skill[]> {
    const skills = new Map<string, Skill>();
    console.log('AI StepFlow: loadSkills starting...');

    for (const dir of this.scopedDirs('skills')) {
      const mdFiles = await this.listFiles(dir, name => name.endsWith('.md'));
      const subDirs = await this.listDirectories(dir);
      console.log(`AI StepFlow: checking dir ${dir}, found ${mdFiles.length} md files and ${subDirs.length} subdirs.`);

      for (const file of mdFiles) {
        const skill = await this.parseSkillFile(path.join(dir, file), true);
        if (skill) skills.set(skill.name, skill);
      }
      for (const sub of subDirs) {
        const skill = await this.parseSkillFolder(path.join(dir, sub));
        if (skill) skills.set(skill.name, skill);
      }
    }

    console.log(`AI StepFlow: loadSkills finished, total ${skills.size} unique skills.`);
    return Array.from(skills.values());
  }

  public async loadFlows(): Promise<Flow[]> {
    const flows = new Map<string, Flow>();
    console.log('AI StepFlow: loadFlows starting...');

    for (const dir of this.scopedDirs('flows')) {
      const files = await this.listFiles(dir, name => name.endsWith('.yaml') || name.endsWith('.yml'));
      console.log(`AI StepFlow: checking dir ${dir}, found ${files.length} flow files.`);
      for (const file of files) {
        const flow = await this.parseFlowFile(path.join(dir, file));
        if (flow) flows.set(flow.id, flow);
      }
    }

    console.log(`AI StepFlow: loadFlows finished, total ${flows.size} unique flows.`);
    return Array.from(flows.values());
  }

  public async saveFlow(flow: Flow, isGlobal: boolean = false): Promise<string> {
    const targetDir = this.resolveTargetDir('flows', isGlobal);
    await fs.mkdir(targetDir, { recursive: true });

    // Slugify the id so user input can never escape the flows directory.
    const filePath = path.join(targetDir, `${this.slugify(flow.id)}.yaml`);
    const payload = {
      id: flow.id,
      name: flow.name,
      description: flow.description,
      inputs: flow.inputs,
      steps: flow.steps
    };

    let baseContent: string | undefined;
    if (flow.sourcePath && this.isManagedPath(flow.sourcePath)) {
      try {
        baseContent = await fs.readFile(flow.sourcePath, 'utf8');
      } catch {
        baseContent = undefined;
      }
    }

    let doc: Document;
    if (baseContent !== undefined) {
      doc = parseDocument(baseContent);
      if (isMap(doc.contents)) {
        for (const [key, value] of Object.entries(payload)) {
          doc.set(key, value);
        }
      } else {
        doc = new Document(payload);
      }
    } else {
      doc = new Document(payload);
    }

    await fs.writeFile(filePath, doc.toString(), 'utf8');

    // Saving to a different location (scope change or rename) moves the flow instead of duplicating it.
    const previous = flow.sourcePath;
    if (previous && path.normalize(previous) !== path.normalize(filePath) && this.isManagedPath(previous)) {
      await fs.rm(previous, { force: true });
    }

    return filePath;
  }

  public async deleteFlow(sourcePath: string): Promise<void> {
    this.assertManagedPath(sourcePath);
    await fs.rm(sourcePath, { force: true });
  }

  public async deleteAgent(sourcePath: string): Promise<void> {
    this.assertManagedPath(sourcePath);
    await fs.rm(sourcePath, { force: true });
  }

  /** Folder-based skills include resources; flat-file skills only remove their markdown file. */
  public async deleteSkill(sourcePath: string): Promise<void> {
    this.assertManagedPath(sourcePath);
    const parent = path.dirname(sourcePath);
    const isFlatFile = this.scopedDirs('skills')
      .some(root => path.normalize(root) === path.normalize(parent));
    const target = path.basename(sourcePath) === 'SKILL.md' && !isFlatFile ? parent : sourcePath;
    this.assertManagedPath(target);
    await fs.rm(target, { recursive: true, force: true });
  }

  public async saveAgent(agent: AgentInput, isGlobal: boolean = false): Promise<string> {
    const targetDir = this.resolveTargetDir('agents', isGlobal);
    await fs.mkdir(targetDir, { recursive: true });

    const filePath = path.join(targetDir, `${this.slugify(agent.name)}.md`);
    const frontmatter = matter.stringify(agent.systemPrompt || '', {
      name: agent.name,
      description: agent.description || '',
      model: agent.model || 'sonnet',
      ...(agent.tools?.length ? { tools: agent.tools } : {})
    });

    await fs.writeFile(filePath, frontmatter, 'utf8');
    return filePath;
  }

  public async saveSkill(skill: SkillInput, isGlobal: boolean = false): Promise<string> {
    const targetDir = path.join(this.resolveTargetDir('skills', isGlobal), this.slugify(skill.name));
    await fs.mkdir(targetDir, { recursive: true });

    const filePath = path.join(targetDir, 'SKILL.md');
    const frontmatter = matter.stringify(skill.instructions || '', {
      name: skill.name,
      description: skill.description || ''
    });

    await fs.writeFile(filePath, frontmatter, 'utf8');
    return filePath;
  }

  /** Parse any agent markdown file the user picked for import. */
  public async importAgentFromFile(filePath: string): Promise<Agent | undefined> {
    return this.parseAgentFile(filePath);
  }

  /** Parse a skill markdown file (SKILL.md or any .md) the user picked for import. */
  public async importSkillFromFile(filePath: string): Promise<Skill | undefined> {
    return this.parseSkillFile(filePath);
  }

  private async parseSkillFile(
    filePath: string,
    logMissing: boolean = true
  ): Promise<Skill | undefined> {
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
        builtIn: this.hasBuiltInMarker(leadingComments)
      };
    } catch (e: any) {
      if (logMissing || e?.code !== 'ENOENT') {
        console.error(`Error parsing skill file ${filePath}:`, e);
      }
      return undefined;
    }
  }

  /** True when the path lives inside one of the directories this extension manages. */
  private isManagedPath(targetPath: string): boolean {
    const normalized = path.normalize(targetPath);
    const roots = [path.join(this.globalPath, '')];
    if (this.projectPath) roots.push(path.join(this.projectPath, '.claude'));
    return roots.some(root => normalized.startsWith(path.normalize(root) + path.sep));
  }

  private assertManagedPath(targetPath: string): void {
    if (!this.isManagedPath(targetPath)) {
      throw new Error(`Refusing to delete a file outside the managed config directories: ${targetPath}`);
    }
  }

  public isGlobalSourcePath(sourcePath: string | undefined): boolean {
    if (!sourcePath) return false;
    const normalized = path.normalize(sourcePath);
    const globalRoot = path.normalize(this.globalPath) + path.sep;
    return normalized.startsWith(globalRoot);
  }

  public getGlobalPath(): string {
    return this.globalPath;
  }

  public getProjectPath(): string | undefined {
    return this.projectPath;
  }

  /** Global dir first so project entries override entries with the same name. */
  private scopedDirs(kind: 'agents' | 'skills' | 'flows'): string[] {
    const dirs = [path.join(this.globalPath, kind)];
    if (this.projectPath) {
      dirs.push(path.join(this.projectPath, '.claude', kind));
    }
    return dirs;
  }

  private resolveTargetDir(kind: 'agents' | 'skills' | 'flows', isGlobal: boolean): string {
    if (isGlobal) return path.join(this.globalPath, kind);
    if (!this.projectPath) {
      throw new Error('No workspace folder is open; cannot save to the current repo. Save globally instead.');
    }
    return path.join(this.projectPath, '.claude', kind);
  }

  private async listFiles(dir: string, predicate: (name: string) => boolean): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter(e => e.isFile() && predicate(e.name)).map(e => e.name);
    } catch {
      return [];
    }
  }

  private async listDirectories(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [];
    }
  }

  private async parseAgentFile(filePath: string): Promise<Agent | undefined> {
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
        sourcePath: filePath,
        builtIn: this.hasBuiltInMarker(leadingComments)
      };
    } catch (e) {
      console.error(`Error parsing agent file ${filePath}:`, e);
      return undefined;
    }
  }

  /** True only for files this extension installed — those stamped with {@link BUILT_IN_MARKER}.
   *  A user's own file (or one installed by a different tool) is never flagged built-in. */
  private hasBuiltInMarker(leadingComments: RegExpMatchArray | null): boolean {
    return !!leadingComments && leadingComments[0].toLowerCase().includes(ConfigManager.BUILT_IN_MARKER);
  }

  private async parseSkillFolder(folderPath: string): Promise<Skill | undefined> {
    const skillFilePath = path.join(folderPath, 'SKILL.md');
    return this.parseSkillFile(skillFilePath, false);
  }

  private async parseFlowFile(filePath: string): Promise<Flow | undefined> {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const data = parse(content);
      const fallbackId = path.basename(filePath, path.extname(filePath));
      return parseFlow(data, fallbackId, filePath);
    } catch (e) {
      console.error(`Error parsing flow file ${filePath}: ${formatFlowError(e)}`);
      return undefined;
    }
  }

  private slugify(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled';
  }
}
