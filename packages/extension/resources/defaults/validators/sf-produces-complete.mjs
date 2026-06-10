// ai-stepflow built-in
/**
 * Validator: sf-produces-complete
 * Verifies that all files listed in the 'produces' metadata are actually present in the output.
 */
export default function validate(output, step) {
  if (!step.produces || step.produces.length === 0) return { ok: true };

  const producedFiles = step.produces;
  const missingFiles = [];

  for (const file of producedFiles) {
    // Check if the filename appears in a code block or path-like string in the output
    const escapedFile = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fileRegex = new RegExp(escapedFile, 'i');
    
    if (!fileRegex.test(output)) {
      missingFiles.push(file);
    }
  }

  if (missingFiles.length > 0) {
    return { 
      ok: false, 
      reason: `Output is missing implementation or mention of required files: ${missingFiles.join(', ')}`
    };
  }

  return { ok: true };
}
