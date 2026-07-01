export type GroupBy = 'list' | 'tag';

export const UNTAGGED = 'Untagged';

/**
 * Group items by their tags for the "group" view. An item with multiple tags appears in each of
 * its tag groups; items without tags fall into a single trailing "Untagged" group. Named groups
 * are sorted alphabetically, with "Untagged" always last.
 */
export function groupByTag<T extends { tags?: string[] }>(items: T[]): { tag: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const tags = item.tags && item.tags.length ? item.tags : [UNTAGGED];
    for (const tag of tags) {
      const bucket = groups.get(tag) ?? [];
      bucket.push(item);
      groups.set(tag, bucket);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === UNTAGGED ? 1 : b === UNTAGGED ? -1 : a.localeCompare(b)))
    .map(([tag, tagItems]) => ({ tag, items: tagItems }));
}

/** Parse a comma/newline-separated tag string into a clean, de-duplicated list. */
export function parseTagsInput(raw: string): string[] {
  return [...new Set(raw.split(/[,\n]/).map(t => t.trim()).filter(Boolean))];
}
