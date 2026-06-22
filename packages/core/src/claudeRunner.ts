import { ChildProcess, spawn } from 'child_process';
import { summarizeUsage } from './runUtils.js';

export interface ClaudeStreamingRunOptions {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  projectPath: string;
  onText: (chunk: string) => void;
  /** Kill the run and resolve as a failure after this many ms. 0/undefined = no limit. */
  timeoutMs?: number;
  /** Cap the number of agentic turns. 0/undefined = no limit. */
  maxTurns?: number;
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

/** Headless Claude runner with NDJSON streaming output and final usage/cost capture. */
export function runClaudeStreaming(opts: ClaudeStreamingRunOptions, spawnFn: SpawnFn = spawn): ClaudeStreamingRunHandle {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', HEADLESS_PERMISSION_MODE];
  if (opts.model) args.push('--model', opts.model);
  if (opts.mcpConfig !== undefined) args.push('--mcp-config', opts.mcpConfig, '--strict-mcp-config');
  if (opts.maxTurns && opts.maxTurns > 0) args.push('--max-turns', String(opts.maxTurns));
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
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
