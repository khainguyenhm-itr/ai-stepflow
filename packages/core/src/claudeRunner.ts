import { ChildProcess, spawn } from 'child_process';
import { summarizeUsage } from './runUtils.js';

export interface ClaudeStreamingRunOptions {
  systemPrompt: string;
  /**
   * When set, `systemPrompt` is used as the **static prefix** (agent + skills body) and this
   * field carries the **dynamic per-run suffix** (inputs, requires, produces). The static prefix
   * is passed via `--system-prompt` so Claude's prompt-prefix cache can serve it from cache on
   * repeated calls; the dynamic suffix is appended via `--append-system-prompt`. When absent,
   * the full `systemPrompt` is appended to whatever Claude's ambient system prompt is, matching
   * the pre-existing behaviour.
   *
   * Practically: headless step runs populate both fields (via {@link composeSystemPromptParts});
   * review runs and interactive steps keep only `systemPrompt` (single string, as before).
   */
  dynamicSystemPrompt?: string;
  userMessage: string;
  model?: string;
  projectPath: string;
  onText: (chunk: string) => void;
  /** Kill the run and resolve as a failure after this many ms. 0/undefined = no limit. */
  timeoutMs?: number;
  /** Cap the number of agentic turns. 0/undefined = no limit. */
  maxTurns?: number;
  /**
   * When set (sandboxed mode), Claude may only write the listed paths. Each path becomes an
   * explicit `Write`/`Edit`/`MultiEdit` allow-rule via `--allowedTools`, and the run drops to
   * {@link SANDBOXED_PERMISSION_MODE} (`default`) instead of auto-accepting every edit. In
   * headless `--print` mode a write to any other path has no prompt to satisfy, so it is denied.
   * Paths should be relative to {@link ClaudeStreamingRunOptions.projectPath} (the run cwd), which
   * is how Claude's permission matcher resolves them. Leave undefined for the default 'trusted'
   * mode (`acceptEdits` permission).
   */
  allowedWritePaths?: string[];
  /**
   * MCP servers (as a `{"mcpServers":{...}}` JSON string) to use for this run, passed via
   * `--mcp-config --strict-mcp-config` so the run ignores the user's ambient MCP config.
   * Headless runs default this to `{}` (no MCP), keeping their tool/instruction context — and
   * token cost — minimal. Undefined leaves the user's MCP config in effect.
   */
  mcpConfig?: string;
}

export interface ClaudeStreamingRunResult {
  success: boolean;
  exitCode: number;
  resultText: string;
  costUsd?: number;
  tokensUsed?: number;
  model?: string;
  /** True when the run was killed because it exceeded {@link ClaudeStreamingRunOptions.timeoutMs}. */
  timedOut?: boolean;
}

/** Exit code reported when a run is killed for exceeding its timeout (mirrors `timeout(1)`). */
export const TIMEOUT_EXIT_CODE = 124;

/** Spawn seam, so tests can inject a fake child process instead of launching `claude`. */
export type SpawnFn = typeof spawn;

export interface ClaudeStreamingRunHandle {
  child: ChildProcess;
  completed: Promise<ClaudeStreamingRunResult>;
}

/**
 * The execution contract a custom runner must satisfy: the same inputs and result
 * as the built-in runner, minus the process handle. Lets a step's agent override how
 * Claude is invoked (alternate endpoint/model, or a deterministic stub in tests).
 */
export type StepRunner = (opts: ClaudeStreamingRunOptions) => Promise<ClaudeStreamingRunResult>;

/** The built-in runner: headless `claude` via {@link runClaudeStreaming}. */
export const defaultStepRunner: StepRunner = opts => runClaudeStreaming(opts).completed;

export const HEADLESS_PERMISSION_MODE = 'acceptEdits';
/**
 * Permission mode used for sandboxed runs (trustLevel: 'sandboxed').
 * In this mode the claude CLI only uses tools explicitly listed — file writes
 * outside the declared produces paths are not permitted.
 */
export const SANDBOXED_PERMISSION_MODE = 'default';

/**
 * Extra settings injected for sandboxed runs to neutralise the user's ambient `.claude/settings.json`.
 * The headless runner does not pass `--settings` for trusted runs, so an ambient `allow: ["Bash"]`
 * (etc.) would otherwise widen a sandboxed run back open. `deny` always wins over `allow`, so denying
 * the execution/network tools here closes that hole without conflicting with the `Write(produces)`
 * allow-rules added via `--allowedTools`. Note: an ambient unscoped `allow: ["Write"]`/`["Edit"]`
 * cannot be revoked additively (denying Write globally would also block the declared produces), so a
 * blanket file-write allow in the user's settings remains a documented limitation of sandboxed mode.
 */
export const SANDBOXED_DENY_SETTINGS = JSON.stringify({ permissions: { deny: ['Bash', 'WebFetch', 'WebSearch'] } });

/** Headless Claude runner with NDJSON streaming output and final usage/cost capture. */
export function runClaudeStreaming(opts: ClaudeStreamingRunOptions, spawnFn: SpawnFn = spawn): ClaudeStreamingRunHandle {
  // Sandboxed runs drop the auto-accept permission mode and whitelist writes to the declared
  // paths only; trusted runs keep acceptEdits so a headless run never stalls on a prompt.
  // `allowedWritePaths` present (even as []) means sandboxed: an empty list is fail-closed
  // (default mode + no write allow-rule → every write is denied). `undefined` means trusted.
  const sandboxed = opts.allowedWritePaths !== undefined;
  const permissionMode = sandboxed ? SANDBOXED_PERMISSION_MODE : HEADLESS_PERMISSION_MODE;
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode];
  if (sandboxed) {
    // Deny exec/network tools regardless of the user's ambient settings (deny beats allow).
    args.push('--settings', SANDBOXED_DENY_SETTINGS);
    if (opts.allowedWritePaths!.length > 0) {
      const rules = opts.allowedWritePaths!.flatMap(p => [`Write(${p})`, `Edit(${p})`, `MultiEdit(${p})`]);
      args.push('--allowedTools', ...rules);
    }
  }
  if (opts.model) args.push('--model', opts.model);
  if (opts.mcpConfig !== undefined) args.push('--mcp-config', opts.mcpConfig, '--strict-mcp-config');
  if (opts.maxTurns && opts.maxTurns > 0) args.push('--max-turns', String(opts.maxTurns));

  // When dynamicSystemPrompt is provided the static prefix goes to --system-prompt (cacheable)
  // and the dynamic suffix is appended. Otherwise fall back to appending the whole prompt.
  if (opts.dynamicSystemPrompt !== undefined) {
    if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);
    if (opts.dynamicSystemPrompt) args.push('--append-system-prompt', opts.dynamicSystemPrompt);
  } else if (opts.systemPrompt) {
    args.push('--append-system-prompt', opts.systemPrompt);
  }

  args.push(opts.userMessage);

  const child = spawnFn('claude', args, { cwd: opts.projectPath || undefined, env: process.env });

  const completed = new Promise<ClaudeStreamingRunResult>(resolve => {
    let buf = '';
    let resultText = '';
    let costUsd: number | undefined;
    let tokensUsed: number | undefined;
    let model: string | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Resolve at most once and always clear the timeout, whether the run ends, errors, or times out.
    const finish = (result: ClaudeStreamingRunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        opts.onText(`\n[run timed out after ${Math.round(opts.timeoutMs! / 1000)}s — killed]\n`);
        finish({ success: false, exitCode: TIMEOUT_EXIT_CODE, resultText, costUsd, tokensUsed, model, timedOut: true });
      }, opts.timeoutMs);
    }

    const handleEvent = (evt: any) => {
      if (!evt || typeof evt !== 'object') return;
      if (evt.type === 'assistant') {
        if (Array.isArray(evt.message?.content)) {
          for (const block of evt.message.content) {
            if (block?.type === 'text' && typeof block.text === 'string') opts.onText(block.text);
          }
        }
        if (typeof evt.message?.model === 'string' && evt.message.model !== '<synthetic>') model = evt.message.model;
        // Accumulate per-turn token counts; result event overrides with the authoritative total.
        const u = summarizeUsage(evt.message?.usage);
        if (u !== undefined) tokensUsed = (tokensUsed ?? 0) + u;
      } else if (evt.type === 'result') {
        if (typeof evt.total_cost_usd === 'number') costUsd = evt.total_cost_usd;
        if (typeof evt.result === 'string') resultText = evt.result;
        if (typeof evt.model === 'string') model = evt.model;
        const u = summarizeUsage(evt.usage);
        if (u !== undefined) tokensUsed = u;
      }
    };

    const consume = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try { handleEvent(JSON.parse(trimmed)); }
      catch { opts.onText(line + '\n'); }
    };

    child.stdout?.on('data', d => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        consume(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr?.on('data', d => opts.onText(d.toString()));
    child.on('close', code => {
      if (buf.length) consume(buf);
      finish({ success: code === 0, exitCode: code ?? 1, resultText, costUsd, tokensUsed, model });
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      // A spawn failure (most often ENOENT: `claude` not on PATH) otherwise surfaces as a bare
      // "exited 1" — name the real cause in the streamed output so the user can act on it.
      const why = err?.code === 'ENOENT'
        ? "claude CLI not found on PATH — install Claude Code or make sure `claude` is on your PATH"
        : `failed to launch claude: ${err?.message ?? 'unknown error'}`;
      opts.onText(`\n[${why}]\n`);
      finish({ success: false, exitCode: 1, resultText, costUsd, tokensUsed, model });
    });
  });

  return { child, completed };
}
