// ai-stepflow built-in
/**
 * Validator: sf-json-valid
 * Verifies that the output contains at least one valid JSON block or matches NDJSON format.
 */
export default function validate(output) {
  const lines = output.trim().split('\n');
  
  // Try NDJSON first
  try {
    for (const line of lines) {
      if (line.trim()) JSON.parse(line);
    }
    return { ok: true };
  } catch {
    // Fallback to searching for JSON blocks
    const jsonRegex = /```json\s*([\s\S]*?)```/g;
    let match;
    let found = false;
    while ((match = jsonRegex.exec(output)) !== null) {
      try {
        JSON.parse(match[1]);
        found = true;
      } catch (e) {
        return { ok: false, reason: `Invalid JSON block: ${e.message}` };
      }
    }
    
    if (found) return { ok: true };
    return { ok: false, reason: "No valid JSON blocks found in output." };
  }
}
