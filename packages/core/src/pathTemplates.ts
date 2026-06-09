/** Resolve `{name}` placeholders from run inputs; unknown keys are left as-is. */
export function resolveTemplate(value: string, inputs: Record<string, string> = {}): string {
  return value.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    const resolved = inputs[key];
    return resolved == null || resolved === '' ? `{${key}}` : resolved;
  });
}

export function resolveTemplates(values: string[] | undefined, inputs: Record<string, string> = {}): string[] {
  return (values ?? []).map(value => resolveTemplate(value, inputs));
}
