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
 * Scans ~/.claude/projects/<workspace-hash>/ for .jsonl files written after startTime,
 * sums token usage from all assistant messages, and derives cost from the model's pricing.
 * Returns empty metrics on any failure so callers are never blocked.
 */
export async function readInteractiveSessionStats(projectPath: string, startTime: Date): Promise<StepMetrics> {
  try {
    // Derive Claude's project folder hash: /foo/bar → -foo-bar
    const hash = projectPath.replace(/\//g, '-');
    const claudeDir = path.join(os.homedir(), '.claude', 'projects', hash);

    if (!fs.existsSync(claudeDir)) return {};

    const startMs = startTime.getTime();
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let lastModel: string | undefined;
    let found = false;

    // Only read files whose mtime is after the step started
    const files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const filePath = path.join(claudeDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < startMs) continue;

      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }

        if (entry.type !== 'assistant') continue;
        const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
        if (ts < startMs) continue;

        const usage = entry.message?.usage;
        if (!usage) continue;
        found = true;

        totalInput     += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        totalOutput    += usage.output_tokens ?? 0;
        totalCacheRead += usage.cache_read_input_tokens ?? 0;

        const model = entry.message?.model;
        if (model && model !== '<synthetic>') lastModel = model;
      }
    }

    if (!found) return {};

    const pricing = pricingForModel(lastModel ?? '');
    const costUsd = (totalInput * pricing.input + totalOutput * pricing.output + totalCacheRead * pricing.cacheRead) / 1_000_000;
    const tokensUsed = totalInput + totalOutput + totalCacheRead;

    return {
      modelUsed: lastModel,
      tokensUsed,
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    };
  } catch {
    return {};
  }
}
