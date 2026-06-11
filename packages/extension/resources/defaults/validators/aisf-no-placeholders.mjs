// ai-stepflow built-in — default review validator.
// Rejects when any produced file still contains leftover placeholder / unfinished-work markers.
import { existsSync, readFileSync } from 'node:fs';

const PATTERNS = [/\bTODO\b/, /\bFIXME\b/, /\bTBD\b/, /<placeholder>/i, /lorem ipsum/i];

export default function review(ctx) {
  const produced = (ctx?.paths?.produces ?? []).filter(existsSync);
  const offenders = [];
  for (const file of produced) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const hit = PATTERNS.find(re => re.test(text));
    if (hit) offenders.push(`${file} (matched ${hit})`);
  }
  if (offenders.length) {
    return { decision: 'reject', reason: `Placeholder/TODO markers found in: ${offenders.join('; ')}` };
  }
  return { decision: 'pass', reason: 'No leftover placeholders or TODO markers in produced files.' };
}
