// ai-stepflow built-in — default review validator.
// Rejects when any produced file still contains leftover placeholder / unfinished-work markers.
import { existsSync, readFileSync } from 'node:fs';

const PATTERNS = [
  { re: /\bTODO\b/, label: 'TODO' },
  { re: /\bFIXME\b/, label: 'FIXME' },
  { re: /\bHACK\b/, label: 'HACK' },
  { re: /\bTEMP\b/, label: 'TEMP' },
  { re: /\bXXX\b/, label: 'XXX' },
  { re: /\bTBD\b/, label: 'TBD' },
  { re: /<placeholder>/i, label: '<placeholder>' },
  { re: /\[placeholder\]/i, label: '[placeholder]' },
  { re: /lorem ipsum/i, label: 'lorem ipsum' },
  { re: /throw new Error\(['"`]not implemented['"`]\)/i, label: 'not-implemented stub' },
  { re: /^\s*\.\.\.\s*$/m, label: 'ellipsis-only line (...)' },
];

export default function review(ctx) {
  const produced = (ctx?.paths?.produces ?? []).filter(existsSync);
  const offenders = [];
  for (const file of produced) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const { re, label } of PATTERNS) {
      if (re.test(text)) {
        offenders.push(`${file} (matched: ${label})`);
        break; // one report per file
      }
    }
  }
  if (offenders.length) {
    return { decision: 'reject', reason: `Placeholder/unfinished markers found in: ${offenders.join('; ')}` };
  }
  return { decision: 'pass', reason: 'No leftover placeholders or unfinished markers in produced files.' };
}
