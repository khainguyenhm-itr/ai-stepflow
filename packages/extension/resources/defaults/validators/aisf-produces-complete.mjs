// ai-stepflow built-in — default review validator.
// Passes when every file the step declares in `produces` exists and is non-empty.
// This is the default gate for AI-reviewed steps that do not configure their own validator.
import { existsSync, statSync } from 'node:fs';

export default function review(ctx) {
  const produced = ctx?.paths?.produces ?? [];
  if (produced.length === 0) {
    return { decision: 'pass', reason: 'No produces declared; nothing to verify.' };
  }
  const missing = produced.filter(p => !existsSync(p));
  if (missing.length) {
    return { decision: 'reject', reason: `Missing produced file(s): ${missing.join(', ')}` };
  }
  const empty = produced.filter(p => { try { return statSync(p).size === 0; } catch { return true; } });
  if (empty.length) {
    return { decision: 'reject', reason: `Produced file(s) are empty: ${empty.join(', ')}` };
  }
  return { decision: 'pass', reason: `All ${produced.length} produced file(s) exist and are non-empty.` };
}
