// ai-stepflow built-in
/**
 * Validator: sf-no-placeholders
 * Ensures the output does not contain common placeholder comments or TODOs.
 */
export default function validate(output) {
  const placeholders = [
    /\/\/\s*\.\.\./i,
    /\/\*\s*\.\.\.\s*\*\//i,
    /<!--\s*\.\.\.\s*-->/i,
    /TODO:/i,
    /FIXME:/i,
    /\[INSERT\s+.*\]/i,
    /<PLACEHOLDER>/i,
    /implementation\s+goes\s+here/i
  ];

  for (const regex of placeholders) {
    if (regex.test(output)) {
      return { 
        ok: false, 
        reason: `Output contains placeholder or unfinished markers: ${output.match(regex)[0]}`
      };
    }
  }

  return { ok: true };
}
