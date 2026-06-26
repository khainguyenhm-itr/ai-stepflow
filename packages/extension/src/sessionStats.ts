import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StepMetrics } from '@ai-stepflow/core';

/** Cost per million tokens by model prefix. Falls back to Sonnet 4.x rates. */
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-4':   { input: 15,   output: 75,   cacheRead: 1.50  },
  'claude-sonnet-4': { input: 3,    output: 15,   cacheRead: 0.30  },
  'claude-haiku-4':  { input: 0.80, output: 4,    cacheRead: 0.08  },
  'claude-opus-3':   { input: 15,   output: 75,   cacheRead: 1.50  },
  'claude-sonnet-3': { input: 3,    output: 15,   cacheRead: 0.30  },
  'claude-haiku-3':  { input: 0.25, output: 1.25, cacheRead: 0.03  },
};
const FALLBACK_PRICING = { input: 3, output: 15, cacheRead: 0.30 };

function pricingForModel(model: string) {
  for (const [prefix, rates] of Object.entries(PRICING)) {
    if (model.startsWith(prefix)) return rates;
  }
  return FALLBACK_PRICING;
}

/**
 * Read usage stats from Claude CLI's local session files for an interactive step.
 * When `sessionId` is given (pinned via `claude --session-id` at launch) only that
 * session's `<sessionId>.jsonl` is read — exact, even when sessions run concurrently.
 * Without it (legacy runs) it falls back to scanning every .jsonl written after startTime.
 * Sums token usage from assistant messages, derives cost from the model's pricing, and
 * collects assistant text as the step output. Returns empty metrics on any failure.
 */
export async function readInteractiveSessionStats(projectPath: string, startTime: Date, sessionId?: string): Promise<StepMetrics> {
  try {
    // Derive Claude's project folder hash. Claude CLI replaces every non-alphanumeric
    // char (slash, underscore, dot, …) with '-', e.g. /a/b_c.d → -a-b-c-d.
    const hash = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const claudeDir = path.join(os.homedir(), '.claude', 'projects', hash);

    if (!fs.existsSync(claudeDir)) return {};

    const startMs = startTime.getTime();
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let lastModel: string | undefined;
    let found = false;
    const textParts: { ts: number; text: string }[] = [];

    // Pinned session → read exactly that file. Legacy runs → scan all .jsonl after startTime.
    const allJsonl = fs.readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
    const files = sessionId
      ? allJsonl.filter(f => f === `${sessionId}.jsonl`)
      : allJsonl;
    if (files.length === 0) return {};
    for (const file of files) {
      const filePath = path.join(claudeDir, file);
      // A pinned session file is entirely this step's run, so skip the time gate
      // (it would wrongly drop everything on clock skew). Legacy scan still gates by time.
      if (!sessionId) {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < startMs) continue;
      }

      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }

        if (entry.type !== 'assistant') continue;
        const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
        if (!sessionId && ts < startMs) continue;

        const usage = entry.message?.usage;
        if (!usage) continue;
        found = true;

        totalInput     += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        totalOutput    += usage.output_tokens ?? 0;
        totalCacheRead += usage.cache_read_input_tokens ?? 0;

        const model = entry.message?.model;
        if (model && model !== '<synthetic>') lastModel = model;

        // Collect the assistant's text so the step record carries the conversation,
        // not just the metrics. Sorted by timestamp below to stay coherent across files.
        if (Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              textParts.push({ ts, text: block.text });
            }
          }
        }
      }
    }

    if (!found) return {};

    const output = textParts
      .sort((a, b) => a.ts - b.ts)
      .map(p => p.text)
      .join('\n');

    const pricing = pricingForModel(lastModel ?? '');
    const costUsd = (totalInput * pricing.input + totalOutput * pricing.output + totalCacheRead * pricing.cacheRead) / 1_000_000;
    const tokensUsed = totalInput + totalOutput + totalCacheRead;

    return {
      modelUsed: lastModel,
      tokensUsed,
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
      ...(output ? { output } : {}),
    };
  } catch {
    return {};
  }
}
