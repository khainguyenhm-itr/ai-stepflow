// ai-stepflow built-in — default review validator.
// Passes when every file the step declares in `produces` exists, is non-empty, and meets
// a minimum size threshold (guards against skeleton files that only contain whitespace/headings).
import { existsSync, statSync, readFileSync } from 'node:fs';

const MIN_CONTENT_BYTES = 80; // below this, a text file is almost certainly a skeleton

export default function review(ctx) {
  const produced = ctx?.paths?.produces ?? [];
  if (produced.length === 0) {
    return { decision: 'pass', reason: 'No produces declared; nothing to verify.' };
  }

  const missing = produced.filter(p => !existsSync(p));
  if (missing.length) {
    return { decision: 'reject', reason: `Missing produced file(s): ${missing.join(', ')}` };
  }

  const empty = produced.filter(p => {
    try { return statSync(p).size === 0; } catch { return true; }
  });
  if (empty.length) {
    return { decision: 'reject', reason: `Produced file(s) are empty: ${empty.join(', ')}` };
  }

  const skeletal = produced.filter(p => {
    try {
      const content = readFileSync(p, 'utf8');
      // Strip whitespace and markdown headings/horizontal-rules to get meaningful byte count
      const meaningful = content.replace(/^[#\s>*_\-=]+$/gm, '').trim();
      return meaningful.length < MIN_CONTENT_BYTES;
    } catch { return false; }
  });
  if (skeletal.length) {
    return { decision: 'reject', reason: `Produced file(s) appear skeletal (< ${MIN_CONTENT_BYTES} bytes of meaningful content): ${skeletal.join(', ')}` };
  }

  return { decision: 'pass', reason: `All ${produced.length} produced file(s) exist and have sufficient content.` };
}
