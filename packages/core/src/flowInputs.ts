import { Flow } from './types.js';

/**
 * Labels of every `required` flow input whose value is missing/blank, in declaration order.
 * The single check both the run-creation UI (webview) and the extension host's `editRunMeta`
 * share, so a required input can't be left empty through either surface.
 *
 * Deliberately its own module with no Node built-in imports (unlike produces.ts, which uses
 * `fs`/`path`) so the browser-side webview bundle can import it directly without pulling in
 * server-only code.
 */
export function missingRequiredInputs(inputs: Flow['inputs'] | undefined, values: Record<string, string>): string[] {
  return Object.entries(inputs || {})
    .filter(([, def]) => def.required)
    .filter(([name]) => !(values[name] || '').trim())
    .map(([name, def]) => def.label || name);
}
