// ai-stepflow built-in — default review validator.
// Rejects when any produced `.json` or `.jsonc` file does not parse as valid JSON.
import { existsSync, readFileSync } from 'node:fs';

function stripJsonComments(text) {
  // Remove single-line (//) and block (/* */) comments for .jsonc support.
  // This is intentionally simple — handles the common cases agents produce.
  return text
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

export default function review(ctx) {
  const jsonFiles = (ctx?.paths?.produces ?? [])
    .filter(p => (p.endsWith('.json') || p.endsWith('.jsonc')) && existsSync(p));

  if (jsonFiles.length === 0) {
    // Not a silent pass — warn if the step is expected to produce structured data
    const allProduced = ctx?.paths?.produces ?? [];
    if (allProduced.length > 0) {
      return { decision: 'pass', reason: `No JSON/JSONC files among ${allProduced.length} produced file(s); skipping JSON validation.` };
    }
    return { decision: 'pass', reason: 'No produces declared; nothing to verify.' };
  }

  for (const file of jsonFiles) {
    try {
      const raw = readFileSync(file, 'utf8');
      const text = file.endsWith('.jsonc') ? stripJsonComments(raw) : raw;
      JSON.parse(text);
    } catch (error) {
      return { decision: 'reject', reason: `Invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return { decision: 'pass', reason: `All ${jsonFiles.length} produced JSON file(s) are valid.` };
}
