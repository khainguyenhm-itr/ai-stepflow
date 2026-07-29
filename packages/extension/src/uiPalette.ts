/**
 * uiPalette.ts — the sidebar's copy of the pinned "GitHub Dark" palette.
 *
 * The cockpit webview owns the canonical values in `packages/webview/src/App.css`; the sidebar is a
 * plain HTML webview in the extension host and cannot import that stylesheet, so the values have to
 * exist here too. Keeping them in one exported table (instead of inline in the HTML template) means
 * a unit test can diff this table against `App.css` and fail when the two drift — previously they
 * were kept in sync by hand and by comment only.
 *
 * `appCssVar` names the counterpart in App.css where the two use different variable names.
 */
export interface PaletteEntry {
  /** CSS custom property as used by the sidebar HTML. */
  name: string;
  value: string;
  /** Counterpart in App.css; defaults to {@link name} when the names already match. */
  appCssVar?: string;
}

export const SIDEBAR_PALETTE: readonly PaletteEntry[] = [
  { name: '--bg', value: '#0d1117' },
  { name: '--border', value: '#30363d' },
  { name: '--panel', value: '#161b22' },
  { name: '--panel-2', value: '#1c2128' },
  { name: '--hover', value: '#1c2128' },
  { name: '--focus', value: '#388bfd' },
  { name: '--btn', value: '#1f6feb', appCssVar: '--btn-bg' },
  { name: '--btn-fg', value: '#ffffff' },
  { name: '--btn-h', value: '#388bfd', appCssVar: '--btn-hover' },
  { name: '--error', value: '#f85149' },
  { name: '--badge', value: '#30363d', appCssVar: '--badge-bg' },
  { name: '--badge-fg', value: '#c9d1d9' },
  { name: '--muted', value: '#8b949e' },
  { name: '--success', value: '#3fb950' },
  { name: '--fg', value: '#c9d1d9' },
];

/** Render the palette as CSS custom-property declarations for a `:root` block. */
export function renderPaletteVars(indent = '      '): string {
  return SIDEBAR_PALETTE.map(entry => `${indent}${entry.name}: ${entry.value};`).join('\n');
}
