// ai-stepflow built-in — default review validator.
// Rejects when any produced `.json` file does not parse as valid JSON.
import { existsSync, readFileSync } from 'node:fs';

export default function review(ctx) {
  const jsonFiles = (ctx?.paths?.produces ?? []).filter(p => p.endsWith('.json') && existsSync(p));
  for (const file of jsonFiles) {
    try {
      JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      return { decision: 'reject', reason: `Invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { decision: 'pass', reason: jsonFiles.length ? `All ${jsonFiles.length} produced JSON file(s) are valid.` : 'No JSON files to verify.' };
}
