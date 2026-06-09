import { ChildProcess, spawn } from 'child_process';
import { summarizeUsage } from './runUtils.js';

export interface ClaudeStreamingRunOptions {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  projectPath: string;
  onText: (chunk: string) => void;
}

export interface ClaudeStreamingRunResult {
  success: boolean;
  exitCode: number;
  resultText: string;
  costUsd?: number;
  tokensUsed?: number;
  model?: string;
}

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
export function runClaudeStreaming(opts: ClaudeStreamingRunOptions): ClaudeStreamingRunHandle {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', HEADLESS_PERMISSION_MODE];
  if (opts.model) args.push('--model', opts.model);
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
  args.push(opts.userMessage);

  const child = spawn('claude', args, { cwd: opts.projectPath || undefined, env: process.env });

  const completed = new Promise<ClaudeStreamingRunResult>(resolve => {
    let buf = '';
    let resultText = '';
    let costUsd: number | undefined;
    let tokensUsed: number | undefined;
    let model: string | undefined;

    const handleEvent = (evt: any) => {
      if (!evt || typeof evt !== 'object') return;
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block?.type === 'text' && typeof block.text === 'string') opts.onText(block.text);
        }
        if (typeof evt.message.model === 'string' && evt.message.model !== '<synthetic>') model = evt.message.model;
      } else if (evt.type === 'result') {
        if (typeof evt.total_cost_usd === 'number') costUsd = evt.total_cost_usd;
        if (typeof evt.result === 'string') resultText = evt.result;
        if (typeof evt.model === 'string') model = evt.model;
        tokensUsed = summarizeUsage(evt.usage);
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
      resolve({ success: code === 0, exitCode: code ?? 1, resultText, costUsd, tokensUsed, model });
    });
    child.on('error', () => {
      resolve({ success: false, exitCode: 1, resultText, costUsd, tokensUsed, model });
    });
  });

  return { child, completed };
}
