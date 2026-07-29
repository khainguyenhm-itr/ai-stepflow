/**
 * Pure metadata parsers for bundled library items — pull a display name/description out of a
 * bundled markdown or JS file's text. No fs access, so they are unit-tested in isolation.
 */

/** First `#`/`##` markdown heading text, or '' if the doc has none. */
export function firstHeading(md: string): string {
  const m = md.match(/^#{1,2}\s+(.+)/m);
  return m ? m[1].trim() : '';
}

/**
 * First leading `//` line comment's text, skipping any `claudesteps`-prefixed marker lines
 * (those are management markers, not a human-facing description). '' when there is none.
 */
export function firstJsComment(js: string): string {
  for (const line of js.split('\n')) {
    const m = line.match(/^\/\/\s*(.+)/);
    if (!m) continue;
    const text = m[1].trim();
    if (text.toLowerCase().startsWith('claudesteps')) continue;
    return text;
  }
  return '';
}
