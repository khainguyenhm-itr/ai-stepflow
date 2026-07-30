import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { renderPaletteVars } from './uiPalette.js';

/**
 * Generates the full HTML for the sidebar webview.
 * Extracted from SidebarProvider._getHtml() to keep the provider file lean.
 */
export function getSidebarHtml(webview: vscode.Webview, _extensionUri: vscode.Uri, version: string): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --r: 3px;
      --r-sm: 2px;
      /* Match the cockpit (packages/webview/src/App.css): follow the VS Code UI
         font size and shrink the whole view uniformly so both read as one product. */
      --font-size: var(--vscode-font-size, 13px);
      --ui-zoom: 0.95;
      /* Pinned "GitHub Dark" palette — identical to the webview (packages/webview/src/App.css) so
         the sidebar and the main cockpit read as one product regardless of VS Code theme. Values
         live in uiPalette.ts and a unit test diffs them against App.css, so the two cannot drift
         silently. */
${renderPaletteVars()}
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; margin: 0; padding: 0; }
    /* Anchor rem to the VS Code base so every font-size (rem = px / 13) scales with it. */
    html { font-size: var(--font-size); }
    body { color: var(--fg); background: var(--panel); font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); font-size: var(--font-size); line-height: 1.4; zoom: var(--ui-zoom); height: calc(100vh / var(--ui-zoom)); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    button { font-family: inherit; cursor: pointer; }

    /* ── shell layout ── */
    .shell { display: flex; flex-direction: column; height: 100%; }

    /* header row */
    .hdr { display: flex; align-items: center; gap: 7px; padding: 10px 12px 0; flex: 0 0 auto; }
    .mark { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: var(--r); background: var(--btn); color: var(--btn-fg); font-size: 0.6923rem; font-weight: 700; flex: 0 0 auto; letter-spacing: .02em; }
    .brand-name { flex: 1; font-size: 0.9615rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ver { color: var(--muted); font-size: 0.7692rem; flex: 0 0 auto; }
    .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--muted); font-size: 1rem; line-height: 1; }
    .icon-btn:hover { color: var(--fg); background: var(--hover); }
    #refresh.spinning { animation: spin .65s linear infinite; pointer-events: none; color: var(--focus); }
    #refresh-status { font-size: 0.7692rem; font-weight: 600; color: var(--success); flex: 0 0 auto; white-space: nowrap; opacity: 0; transition: opacity .2s; }
    #refresh-status.show { opacity: 1; }

    /* scrollable content area — flex column so expanded accordion section can grow */
    .body { flex: 1 1 0; overflow: hidden; display: flex; flex-direction: column; padding: 0 12px 8px; }

    /* ── accordion: expanded section fills remaining sidebar height ── */
    .sec.expanded { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
    .sec.expanded > .sec-hdr { flex: 0 0 auto; }
    .sec.expanded > .box { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; margin-top: 5px; }
    .sec.expanded > .box > .box-tabs,
    .sec.expanded > .box > .box-search { flex: 0 0 auto; }
    .sec.expanded > .box > #mcp,
    .sec.expanded > .box > #plugins,
    .sec.expanded > .box > #runs { flex: 1; min-height: 0; overflow-y: auto; max-height: none; scrollbar-width: none; }
    .sec.expanded > .box > #mcp::-webkit-scrollbar,
    .sec.expanded > .box > #plugins::-webkit-scrollbar,
    .sec.expanded > .box > #runs::-webkit-scrollbar { display: none; }
    /* Default Library expanded */
    .sec.expanded > #defaults-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; margin-top: 3px; }
    .sec.expanded .lib-panel { flex: 1; min-height: 0; max-height: none; overflow-y: auto; }

    /* ── run cards ── */
    #runs { padding: 4px 6px; display: flex; flex-direction: column; gap: 6px; }
    .run-card { padding: 8px 10px 8px 13px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel); cursor: default; transition: border-color .15s, background .15s; position: relative; }
    .run-card::before { content: ''; position: absolute; left: 0; top: 4px; bottom: 4px; width: 3px; border-radius: 0 2px 2px 0; background: var(--border); }
    .run-card:hover { border-color: var(--focus); background: var(--hover); }
    .run-card.run-active::before { background: var(--btn); }
    .run-card.run-done::before { background: var(--success); }
    .run-card.run-done:hover { border-color: var(--success); }
    .run-card-head { display: flex; align-items: flex-start; gap: 5px; min-width: 0; }
    .run-card-titles { flex: 1; min-width: 0; overflow: hidden; }
    .run-card-title { font-size: 0.9231rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); line-height: 1.3; }
    .run-card-sub { font-size: 0.7692rem; color: var(--muted); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-card-bar { height: 3px; border-radius: 2px; background: rgba(127,127,127,.15); overflow: hidden; margin: 6px 0 5px; }
    .run-card-bar-fill { height: 100%; border-radius: 2px; background: var(--vscode-progressBar-background, #0e70c0); transition: width .3s ease; }
    .run-card.run-active .run-card-bar-fill { background: var(--btn); }
    .run-card.run-done .run-card-bar-fill { background: var(--success); }
    .run-card.run-reviewing::before { background: var(--vscode-charts-yellow, #d7ba7d); }
    .run-card.run-reviewing .run-card-bar-fill { background: var(--vscode-charts-yellow, #d7ba7d); }
    .run-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .run-card-meta { font-size: 0.7692rem; color: var(--muted); }
    .run-card-acts { flex-shrink: 0; opacity: 1; }
    .run-card:hover .run-card-acts, .run-card.run-active .run-card-acts { opacity: 1; }
    .run-sbadge { display: inline-flex; align-items: center; height: 14px; padding: 0 5px; border-radius: 9px; font-size: 0.6923rem; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; white-space: nowrap; flex-shrink: 0; margin-top: 1px; }
    .run-sbadge.running { background: var(--vscode-charts-blue, var(--focus)); color: #fff; }
    .run-sbadge.reviewing { background: var(--vscode-charts-yellow, #d7ba7d); color: #1e1e1e; }
    .run-sbadge.done { background: var(--success); color: #fff; }
    .run-sbadge.partial { background: rgba(215,160,0,.18); color: var(--vscode-charts-yellow, #d7ba7d); }
    .run-step-row { display: flex; align-items: center; gap: 4px; overflow: hidden; }
    .run-step-name { font-size: 0.7692rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* badge */
    .badge { display: inline-flex; align-items: center; height: 16px; padding: 0 6px; border-radius: 9px; font-size: 0.6923rem; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--badge-fg); background: var(--badge); white-space: nowrap; flex: 0 0 auto; }
    .badge.running { background: var(--vscode-charts-blue, var(--focus)); }
    .badge.completed { background: var(--success); }

    /* ── settings ── */
    .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; }
    .setting-row + .setting-row { border-top: 1px solid rgba(127,127,127,.07); }
    .setting-label { font-size: 0.8462rem; color: var(--fg); font-weight: 500; }
    .setting-desc { font-size: 0.7692rem; color: var(--muted); margin-top: 1px; }
    .gx-dot { display: none; width: 6px; height: 6px; border-radius: 50%; margin-right: 5px; vertical-align: middle; background: var(--muted); }
    /* GitNexus row stacks vertically: status line (with ··· menu) on top, controls on a second line. */
    .gx-row { flex-direction: column; align-items: stretch; gap: 8px; }
    .gx-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .gx-ctl { display: flex; align-items: center; gap: 6px; }
    .account-ctl { display: flex; align-items: center; gap: 6px; }

    /* ── section ── */
    .sec { margin-top: 8px; }
    .stats-sec { margin-bottom: 4px; }
    .sec-hdr { display: flex; align-items: center; gap: 6px; margin-bottom: 0px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); overflow: hidden; }
    .sec-label { flex: 1; font-size: 0.9231rem; font-weight: 700; color: var(--fg); }
    .sec-count { display: inline-flex; align-items: center; height: 15px; padding: 0 5px; border-radius: 9px; font-size: 0.6923rem; font-weight: 700; color: var(--badge-fg); background: var(--badge); }
    .sec-count:empty { display: none; }
    .sec-toggle { display: flex; align-items: center; gap: 7px; width: 100%; padding: 9px 8px; border: 0; background: transparent; color: inherit; text-align: left; font-family: inherit; transition: background .1s; }
    .sec-toggle:hover { background: var(--hover); }

    /* ── library stats ── */
    .stats { display: flex; gap: 5px; }
    .stat { flex: 1; min-width: 0; padding: 7px 8px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); cursor: pointer; text-align: center; transition: border-color .1s, background .1s; }
    .stat:hover { border-color: var(--focus); }
    .stat-num { font-size: 1.385rem; font-weight: 700; line-height: 1.1; }
    .stat-lbl { font-size: 0.6923rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-top: 2px; }

    /* default library expandable */
    .lib-toggle { display: flex; align-items: center; gap: 7px; padding: 9px 8px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); cursor: pointer; width: 100%; text-align: left; font-family: inherit; color: var(--fg); transition: background .1s; }
    .lib-toggle:hover { background: var(--hover); }
    .lib-caret { font-size: 0.6923rem; color: var(--muted); transition: transform .15s; flex: 0 0 auto; }
    .lib-caret.open { transform: rotate(90deg); }
    .lib-toggle-label { flex: 1; font-size: 0.9231rem; font-weight: 700; color: var(--fg); }
    .lib-toggle-badge { display: inline-flex; align-items: center; height: 15px; padding: 0 5px; border-radius: 9px; font-size: 0.6923rem; font-weight: 700; color: var(--badge-fg); background: var(--success); flex: 0 0 auto; }
    .lib-toggle-badge:empty { display: none; }
    .lib-panel { margin-top: 2px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); overflow: hidden; }

    /* ── box (bordered list container) ── */
    .box { border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); overflow: hidden; }

    /* tabs inside box */
    .box-tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 8px; background: var(--panel); }
    .tab { padding: 6px 8px 5px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); font-size: 0.8846rem; font-weight: 600; cursor: pointer; line-height: 1.4; }
    .tab:hover { color: var(--fg); }
    .tab.active { color: var(--fg); border-bottom-color: var(--focus); }

    /* search row inside box */
    .box-search { padding: 5px 8px; border-bottom: 1px solid var(--border); background: var(--panel); }
    .search { width: 100%; padding: 3px 7px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); font-size: 0.8846rem; font-family: inherit; outline: none; }
    .search:focus { border-color: var(--focus); }
    .search::placeholder { color: var(--vscode-input-placeholderForeground, #818181); }

    /* ── list items ── */
    .item { position: relative; display: grid; grid-template-columns: 8px minmax(0,1fr) auto; align-items: center; gap: 6px; min-height: 36px; padding: 5px 8px; transition: background .1s; }
    .item + .item { border-top: 1px solid rgba(127,127,127,.07); }
    .item:hover { background: var(--hover); }
    .item-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; }
    .item-body { min-width: 0; }
    .item-name { display: block; font-size: 0.8846rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3; }
    .item-sub { display: block; font-size: 0.7692rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3; margin-top: 1px; }
    /* action buttons: hidden until hover so narrow sidebars don't clip content */
    .item-acts { display: flex; align-items: center; gap: 3px; opacity: 0; transition: opacity .1s; }
    .item:hover .item-acts, .item.menu-open .item-acts { opacity: 1; }
    .item.has-update .item-acts { opacity: 1; }
    .update-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-charts-yellow, #d7ba7d); margin-left: 5px; flex-shrink: 0; vertical-align: middle; }
    .icon-update { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--vscode-charts-yellow, #d7ba7d); font-size: 1.077rem; line-height: 1; cursor: pointer; font-family: inherit; }
    .icon-update:hover { border-color: var(--vscode-charts-yellow, #d7ba7d); background: var(--hover); }

    /* ── pill action buttons ── */
    .pill { display: inline-flex; align-items: center; justify-content: center; height: 22px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--r-sm); background: transparent; color: var(--fg); font-size: 0.8077rem; font-weight: 600; cursor: pointer; white-space: nowrap; font-family: inherit; transition: background .1s, border-color .1s; }
    .pill:hover { background: var(--hover); }
    .pill[disabled] { opacity: .4; cursor: default; }
    .pill.accent { border-color: var(--btn); background: var(--btn); color: var(--btn-fg); }
    .pill.accent:hover { background: var(--btn-h); border-color: var(--btn-h); }
    .pill.danger:hover { color: var(--error); border-color: var(--error); background: transparent; }

    /* ── tag filter chips ── */
    .tag-filters { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px 2px; }
    .tag-chip { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border: 1px solid var(--border); border-radius: 9px; background: transparent; color: var(--muted); font-size: 0.7692rem; font-weight: 600; cursor: pointer; white-space: nowrap; font-family: inherit; transition: background .1s, color .1s, border-color .1s; }
    .tag-chip:hover { background: var(--hover); color: var(--fg); }
    .tag-chip.active { background: var(--btn); border-color: var(--btn); color: var(--btn-fg); }

    /* ── context menu (details dropdown) ── */
    .menu { position: relative; }
    .menu > summary { list-style: none; }
    .menu > summary::-webkit-details-marker { display: none; }
    .menu-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--muted); font-size: 1.077rem; font-weight: 700; cursor: pointer; line-height: 1; font-family: inherit; }
    .menu-btn:hover, .menu[open] .menu-btn { color: var(--fg); background: var(--hover); border-color: var(--border); }
    .menu-pop { position: fixed; z-index: 9999; min-width: 130px; max-width: calc(100vw - 12px); padding: 3px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); box-shadow: 0 6px 20px rgba(0,0,0,.36); }
    .menu-item { display: flex; align-items: center; width: 100%; min-height: 26px; border: 0; border-radius: var(--r-sm); padding: 4px 8px; background: transparent; color: var(--fg); font-size: 0.8846rem; font-family: inherit; text-align: left; cursor: pointer; }
    .menu-item:hover { background: var(--hover); }
    .menu-item.danger { color: var(--error); }
    .menu-item[disabled] { opacity: .4; cursor: default; pointer-events: none; }
    .menu-item .mi-check { width: 12px; margin-right: 4px; opacity: .9; flex: 0 0 auto; }
    .menu-label { padding: 5px 8px 2px; font-size: 0.7308rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted, #888); }
    .menu-sep { height: 1px; margin: 3px 4px; background: var(--border); }

    /* ── select dropdowns ── */
    .select-wrap { position: relative; display: inline-block; min-width: 90px; }
    .select-wrap.sm { min-width: 80px; }
    .gx-ctl .select-wrap { flex: 1 1 auto; min-width: 0; display: block; }
    .select-wrap::after { content: ''; position: absolute; right: 9px; top: 50%; transform: translateY(-50%); width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid #aaa; pointer-events: none; }
    .input { width: 100%; height: 22px; padding: 0 24px 0 8px; border: 1px solid var(--border); border-radius: var(--r); background: var(--panel-2); color: var(--fg); font-size: 0.9231rem; font-family: inherit; outline: none; appearance: none; -webkit-appearance: none; cursor: pointer; box-shadow: inset 0 1px 2px rgba(0,0,0,.2); }
    .input.sm { font-size: 0.8462rem; }
    .input:focus { border-color: var(--focus); outline: 1px solid var(--focus); }
    .input:hover { border-color: var(--focus); }

    /* list footer */
    .list-more { display: flex; align-items: center; gap: 6px; font-size: 0.8077rem; color: var(--muted); padding: 5px 8px 6px; border-top: 1px solid rgba(127,127,127,.08); }
    /* Default Library search bar: sticky so it stays visible while scrolling items */
    .lib-panel .box-search { position: sticky; top: 0; z-index: 1; background: var(--panel); border-bottom: 1px solid var(--border); }

    /* ── states ── */
    .empty { display: block; color: var(--muted); font-size: 0.8846rem; padding: 8px; font-style: italic; }
    .skel { display: flex; flex-direction: column; gap: 7px; padding: 10px 8px; }
    .skel-line { height: 11px; border-radius: 2px; background: linear-gradient(90deg, rgba(127,127,127,.10) 25%, rgba(127,127,127,.18) 37%, rgba(127,127,127,.10) 63%); background-size: 400% 100%; animation: shimmer 1.4s ease infinite; }
    .skel-line:nth-child(2) { width: 68%; }
    .skel-line:nth-child(3) { width: 80%; }
    @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spin { display: inline-block; width: 9px; height: 9px; border: 1.5px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin .65s linear infinite; vertical-align: middle; margin-right: 4px; flex-shrink: 0; }

    /* fallback scroll for non-expanded state */
    #mcp, #plugins, #runs { overflow-y: auto; scrollbar-width: none; }
    #mcp::-webkit-scrollbar, #plugins::-webkit-scrollbar, #runs::-webkit-scrollbar { display: none; }
    .lib-panel { overflow-y: auto; scrollbar-width: none; }
    .lib-panel::-webkit-scrollbar { display: none; }

    footer { display: none; }

    /* ── loading overlay ── */
    .loading-overlay { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; background: var(--panel); z-index: 100; }
    .loading-overlay .spin-lg { width: 20px; height: 20px; border: 2px solid var(--border); border-top-color: var(--focus); border-radius: 50%; animation: spin 0.8s linear infinite; }
    .loading-overlay .load-txt { color: var(--muted); font-size: 0.8462rem; }
  </style>
</head>
<body>
<div class="shell">

  <div id="loading-overlay" class="loading-overlay">
    <div class="spin-lg"></div>
    <span class="load-txt">Loading…</span>
  </div>

  <!-- header: brand + version + refresh -->
  <div class="hdr">
    <span class="brand-name">CSF</span>
    <span id="refresh-status" aria-live="polite"></span>
    ${version ? `<span class="ver">v${version}</span>` : ''}
    <button class="icon-btn" id="refresh" title="Refresh" aria-label="Refresh">↻</button>
  </div>

  <!-- scrollable content -->
  <div class="body">

    <!-- library stats -->
    <section class="sec stats-sec">
      <div class="stats" id="stats"></div>
    </section>

    <!-- default library -->
    <section class="sec">
      <div id="defaults-toggle"></div>
      <div id="defaults-panel" style="display:none"></div>
    </section>

    <!-- MCP connections -->
    <section class="sec">
      <div class="sec-hdr">
        <button class="sec-toggle" id="mcp-section-toggle" type="button" aria-expanded="false">
          <span class="lib-caret open" id="mcp-caret">&#9658;</span>
          <span class="sec-label">MCP Connections</span>
          <span class="sec-count" id="conn-count"></span>
        </button>
      </div>
      <div class="box" id="mcp-panel">
        <div class="box-tabs" id="mcp-tabs">
          <button class="tab active" type="button" data-tab="installed">Installed</button>
          <button class="tab" type="button" data-tab="available">Available</button>
        </div>
        <div class="box-search">
          <input class="search" id="mcp-search" type="text" placeholder="Filter servers…" autocomplete="off" spellcheck="false">
        </div>
        <div id="mcp"><div class="skel"><div class="skel-line"></div><div class="skel-line"></div></div></div>
      </div>
    </section>

    <!-- plugins -->
    <section class="sec">
      <div class="sec-hdr">
        <button class="sec-toggle" id="plugins-section-toggle" type="button" aria-expanded="false">
          <span class="lib-caret open" id="plugins-caret">&#9658;</span>
          <span class="sec-label">Plugins</span>
          <span class="sec-count" id="plug-count"></span>
        </button>
      </div>
      <div class="box" id="plugins-panel">
        <div class="box-tabs" id="plugin-tabs">
          <button class="tab active" type="button" data-tab="installed">Installed</button>
          <button class="tab" type="button" data-tab="marketplace">Available</button>
        </div>
        <div class="box-search">
          <input class="search" id="plugin-search" type="text" placeholder="Filter plugins…" autocomplete="off" spellcheck="false">
        </div>
        <div id="plugins"><div class="skel"><div class="skel-line"></div><div class="skel-line"></div><div class="skel-line"></div></div></div>
      </div>
    </section>

    <!-- project settings -->
    <section class="sec">
      <div class="sec-hdr">
        <button class="sec-toggle" id="settings-section-toggle" type="button" aria-expanded="false">
          <span class="lib-caret" id="settings-caret">&#9658;</span>
          <span class="sec-label">Project Settings</span>
        </button>
      </div>
      <div class="box" id="settings-panel" style="display:none">
        <div class="setting-row">
          <div>
            <div class="setting-label">AI Response Style</div>
            <div class="setting-desc">Controls verbosity of AI step output</div>
          </div>
          <span class="select-wrap sm"><select id="ai-style-select" class="input sm">
            <option value="default">Default</option>
            <option value="concise">Concise</option>
          </select></span>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">Review Kit</div>
            <div class="setting-desc">Kit the deep AI-review layer uses to judge artifacts</div>
          </div>
          <span class="select-wrap sm"><select id="review-kit-select" class="input sm">
            <option value="">Default</option>
          </select></span>
        </div>
        <div class="setting-row" id="account-setting-row">
          <div>
            <div class="setting-label">Claude Account</div>
            <div class="setting-desc">Active login — switching applies to all Claude on this machine</div>
          </div>
          <div class="account-ctl">
            <span class="select-wrap sm"><select id="account-select" class="input sm"></select></span>
          </div>
        </div>
        <div class="setting-row gx-row" id="gitnexus-setting-row" style="display:none">
          <div class="gx-head">
            <div style="min-width:0">
              <div class="setting-label"><span id="gitnexus-dot" class="gx-dot"></span>GitNexus</div>
              <div class="setting-desc" id="gitnexus-desc">Build the GitNexus knowledge graph</div>
            </div>
            <details class="menu" id="gitnexus-menu">
              <summary class="menu-btn" title="More actions" aria-label="More">···</summary>
              <div class="menu-pop" id="gitnexus-menu-pop"></div>
            </details>
          </div>
          <div class="gx-ctl">
            <button id="gitnexus-analyze-btn" class="pill accent" type="button">Analyze</button>
          </div>
        </div>
      </div>
    </section>

    <!-- runs (active + recent) -->
    <section class="sec">
      <div class="sec-hdr">
        <button class="sec-toggle" id="runs-section-toggle" type="button" aria-expanded="false">
          <span class="lib-caret open" id="runs-caret">&#9658;</span>
          <span class="sec-label">Runs</span>
          <span class="sec-count" id="runs-count"></span>
        </button>
      </div>
      <div class="box" id="runs-panel">
        <div class="box-search">
          <input class="search" id="runs-search" type="text" placeholder="Filter runs…" autocomplete="off" spellcheck="false">
        </div>
        <div id="runs"><span class="empty">No runs yet</span></div>
      </div>
    </section>

  </div><!-- /.body -->
</div><!-- /.shell -->
<footer>ClaudeSteps</footer>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let refreshing = false;
  let refreshStatusTimer = null;
  document.getElementById('refresh').onclick = () => {
    if (refreshing) return;
    refreshing = true;
    const btn = document.getElementById('refresh');
    btn.classList.add('spinning');
    btn.setAttribute('aria-busy', 'true');
    const status = document.getElementById('refresh-status');
    if (status) { status.classList.remove('show'); status.textContent = ''; }
    clearTimeout(refreshStatusTimer);
    vscode.postMessage({ type: 'refresh' });
  };
  // Called when fresh data lands after a manual refresh: stop the spin, flash "Updated ✓".
  function finishRefresh() {
    if (!refreshing) return;
    refreshing = false;
    const btn = document.getElementById('refresh');
    btn.classList.remove('spinning');
    btn.removeAttribute('aria-busy');
    const status = document.getElementById('refresh-status');
    if (status) {
      status.textContent = 'Updated ✓';
      status.classList.add('show');
      refreshStatusTimer = setTimeout(() => status.classList.remove('show'), 2000);
    }
  }

  // ── Per-repo sidebar state persistence (via .claudesteps/ui-prefs.json) ──
  function saveSidebarState() {
    vscode.postMessage({ type: 'savePref', key: 'sidebar:state', value: JSON.stringify({
      sectionOpen,
      libActiveTab,
      libActiveTags: [...libActiveTags]
    }) });
  }
  function restoreSidebarState(uiPrefs) {
    try {
      const raw = uiPrefs && uiPrefs['sidebar:state'];
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.sectionOpen && typeof p.sectionOpen === 'object') Object.assign(sectionOpen, p.sectionOpen);
      if (p.libActiveTab) libActiveTab = p.libActiveTab;
      if (Array.isArray(p.libActiveTags)) libActiveTags = new Set(p.libActiveTags);
    } catch (_) {}
  }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTime = iso => { const d = new Date(iso); return !isNaN(d.getTime()) ? d.toLocaleString() : esc(iso); };
  const fmtDate = iso => { const d = new Date(iso); if (isNaN(d.getTime())) return esc(iso); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  const statusText = s => s === 'connected' ? 'Connected' : s === 'needs-auth' ? 'Needs auth' : s === 'failed' ? 'Failed' : s || 'Not added';
  const spinHtml = '<span class="spin" aria-hidden="true"></span>';
  const actionMenu = items => items && items.length
    ? '<details class="menu"><summary class="menu-btn" title="More actions" aria-label="More">···</summary><div class="menu-pop">' + items.join('') + '</div></details>'
    : '';
  const menuItem = (label, attrs, danger, disabled) =>
    '<button class="menu-item' + (danger ? ' danger' : '') + '" type="button" ' + (disabled ? 'disabled ' : '') + attrs + '>' + esc(label) + '</button>';

  function positionMenu(menu) {
    const btn = menu.querySelector('.menu-btn');
    const pop = menu.querySelector('.menu-pop');
    if (!btn || !pop) return;

    pop.style.left = '0px';
    pop.style.right = 'auto';
    pop.style.top = '0px';

    const margin = 6;
    const btnRect = btn.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;
    const width = Math.min(popRect.width, Math.max(0, viewportW - margin * 2));
    const height = popRect.height;

    let left = btnRect.right - width;
    left = Math.max(margin, Math.min(left, viewportW - width - margin));

    let top = btnRect.bottom + 4;
    if (top + height > viewportH - margin) {
      top = btnRect.top - height - 4;
    }
    top = Math.max(margin, Math.min(top, viewportH - height - margin));

    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  // Close any open menu when clicking outside it; position opened menu-pop via fixed coords.
  document.addEventListener('click', e => {
    const menu = e.target instanceof Element ? e.target.closest('.menu') : null;
    document.querySelectorAll('.menu[open]').forEach(n => {
      if (n !== menu) {
        n.open = false;
        n.closest('.item')?.classList.remove('menu-open');
      }
    });
  });
  document.addEventListener('toggle', e => {
    const menu = e.target instanceof Element ? e.target.closest('.menu') : null;
    if (!menu) return;
    menu.closest('.item')?.classList.toggle('menu-open', menu.open);
    if (menu.open) positionMenu(menu);
  }, true);
  window.addEventListener('resize', () => {
    document.querySelectorAll('.menu[open]').forEach(positionMenu);
  });

  let activePluginTab = 'installed';
  let pluginQuery = '';
  let installedPlugins = [];
  let availablePlugins = [];
  let lastRunFiles = [];
  let lastRunTotal = 0;
  // lib is included — all 5 sections share the same accordion state and helpers
  const sectionOpen = { lib: false, mcp: false, plugins: false, runs: false, settings: false };

  function _applySection(key, open) {
    sectionOpen[key] = open;
    let toggle, sec, panel, caret;
    if (key === 'lib') {
      toggle = document.getElementById('lib-toggle-btn');
      sec    = document.getElementById('defaults-toggle') && document.getElementById('defaults-toggle').closest('.sec');
      panel  = document.getElementById('defaults-panel');
      caret  = toggle && toggle.querySelector('.lib-caret');
      if (sec) sec.classList.toggle('expanded', open);
      if (caret) caret.className = 'lib-caret' + (open ? ' open' : '');
      renderDefaultsPanel();
    } else {
      toggle = document.getElementById(key + '-section-toggle');
      sec    = toggle && toggle.closest('.sec');
      panel  = document.getElementById(key + '-panel');
      caret  = document.getElementById(key + '-caret');
      if (sec)    sec.classList.toggle('expanded', open);
      if (panel)  panel.style.display = open ? '' : 'none';
      if (caret)  caret.className = 'lib-caret' + (open ? ' open' : '');
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  function setSectionOpen(key, open) {
    if (open) Object.keys(sectionOpen).filter(k => k !== key).forEach(k => _applySection(k, false));
    _applySection(key, open);
    saveSidebarState();
  }

  // lib toggle is rendered dynamically in renderDefaults — wired there
  ['mcp', 'plugins', 'runs', 'settings'].forEach(key => {
    const toggle = document.getElementById(key + '-section-toggle');
    if (!toggle) return;
    toggle.onclick = () => setSectionOpen(key, !sectionOpen[key]);
    _applySection(key, false);
  });

  // Plugin tab switcher
  document.querySelectorAll('#plugin-tabs .tab').forEach(n => {
    n.onclick = () => {
      document.querySelectorAll('#plugin-tabs .tab').forEach(t => t.classList.remove('active'));
      n.classList.add('active');
      activePluginTab = n.getAttribute('data-tab');
      renderPlugins();
    };
  });
  document.getElementById('plugin-search').addEventListener('input', e => {
    pluginQuery = e.target.value.trim().toLowerCase();
    renderPlugins();
  });

  // MCP tabs + search
  let activeMcpTab = 'installed';
  let mcpQuery = '';
  let mcpServers = [];
  document.querySelectorAll('#mcp-tabs .tab').forEach(n => {
    n.onclick = () => {
      document.querySelectorAll('#mcp-tabs .tab').forEach(t => t.classList.remove('active'));
      n.classList.add('active');
      activeMcpTab = n.getAttribute('data-tab');
      renderMcp();
    };
  });
  document.getElementById('mcp-search').addEventListener('input', e => {
    mcpQuery = e.target.value.trim().toLowerCase();
    renderMcp();
  });

  // Runs search
  let runsQuery = '';
  document.getElementById('runs-search').addEventListener('input', e => {
    runsQuery = e.target.value.trim().toLowerCase();
    renderRuns(lastRunFiles, lastRunTotal);
  });

  // ── render functions ──

  function renderStats(s) {
    const items = [['flows', s.flows, 'Flows'], ['agents', s.agents, 'Agents'], ['skills', s.skills, 'Skills']];
    document.getElementById('stats').innerHTML = items.map(([key, n, lbl]) =>
      '<div class="stat" data-tab="' + key + '" title="Open ' + lbl + '">' +
      '<div class="stat-num">' + n + '</div>' +
      '<div class="stat-lbl">' + lbl + '</div>' +
      '</div>'
    ).join('');
    document.querySelectorAll('.stat').forEach(n => {
      n.onclick = () => vscode.postMessage({ type: 'openOverview', tab: n.getAttribute('data-tab') });
    });
  }

  let defaultItemsData = [];
  let libQuery = '';
  let libActiveTab = 'agents'; // 'agents' | 'skills'
  let libActiveTags = new Set(); // currently selected tag filters
  const libPendingOps = new Map(); // filename → 'installing' | 'updating' | 'removing'
  const LIB_TABS = [
    { key: 'agents', label: 'Agents' },
    { key: 'skills', label: 'Skills' },
  ];

  function renderDefaults(items) {
    defaultItemsData = items || [];
    libPendingOps.clear(); // data refresh = operation settled
    const installedCount = defaultItemsData.filter(i => i.installed).length;
    const toggle = document.getElementById('defaults-toggle');
    toggle.innerHTML =
      '<button class="lib-toggle" id="lib-toggle-btn">' +
      '<span class="lib-caret' + (sectionOpen.lib ? ' open' : '') + '">&#9658;</span>' +
      '<span class="lib-toggle-label">Default Library</span>' +
      (installedCount ? '<span class="lib-toggle-badge">' + installedCount + ' installed</span>' : '') +
      '</button>';
    document.getElementById('lib-toggle-btn').onclick = () => setSectionOpen('lib', !sectionOpen.lib);
    renderDefaultsPanel();
  }

  function fmtDefaultName(name) {
    return name.replace(/^csf-(?:agent|skill|review|validator)?-?/, '').replace(/-/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());
  }

  function renderDefaultsPanel() {
    const panel = document.getElementById('defaults-panel');
    const btn = document.getElementById('lib-toggle-btn');
    if (btn) btn.querySelector('.lib-caret').className = 'lib-caret' + (sectionOpen.lib ? ' open' : '');
    if (!sectionOpen.lib) { panel.style.display = 'none'; return; }
    panel.style.display = '';

    const q = libQuery;
    const tabItems = defaultItemsData
      .filter(i => i.kind === libActiveTab)
      .sort((a, b) => (Number(!!b.installed) - Number(!!a.installed)) || a.filename.localeCompare(b.filename));

    // collect all unique tags from items in this tab, sorted alphabetically
    const allTags = [...new Set(tabItems.flatMap(i => i.tags || []))].sort();

    const items = tabItems.filter(i => {
      const matchesQuery = !q || i.filename.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q);
      const matchesTags = libActiveTags.size === 0 || (i.tags || []).some(t => libActiveTags.has(t));
      return matchesQuery && matchesTags;
    });

    const tabsHtml = '<div class="box-tabs" id="lib-tabs">' +
      LIB_TABS.map(t => {
        const count = defaultItemsData.filter(i => i.kind === t.key).length;
        return '<button class="tab' + (libActiveTab === t.key ? ' active' : '') + '" type="button" data-lib-tab="' + t.key + '">' +
          t.label + (count ? ' <span class="sec-count">' + count + '</span>' : '') +
          '</button>';
      }).join('') +
      '</div>';

    const itemsHtml = items.length
      ? items.map(item => {
          const pending = libPendingOps.get(item.filename);
          let actsHtml;
          if (pending) {
            const label = pending === 'installing' ? 'Installing…' : pending === 'updating' ? 'Updating…' : 'Removing…';
            actsHtml = '<button class="pill" type="button" disabled>' + spinHtml + label + '</button>';
          } else if (item.installed) {
            actsHtml =
              (item.hasUpdate ? '<button class="icon-update" type="button" data-act="updateDefault" data-kind="' + esc(item.kind) + '" data-filename="' + esc(item.filename) + '" title="Update available">↑</button>' : '') +
              (item.inUse
                ? '<button class="pill" type="button" disabled title="Used by a flow — remove from flows first">Remove</button>'
                : '<button class="pill danger" type="button" data-act="uninstallDefault" data-kind="' + esc(item.kind) + '" data-filename="' + esc(item.filename) + '">Remove</button>');
          } else {
            actsHtml = '<button class="pill accent" type="button" data-act="installDefault" data-kind="' + esc(item.kind) + '" data-filename="' + esc(item.filename) + '">Install</button>';
          }
          return '<div class="item' + (item.hasUpdate ? ' has-update' : '') + '">' +
            '<span class="item-dot" style="background:' + (item.installed ? 'var(--success)' : 'var(--badge)') + '"></span>' +
            '<span class="item-body">' +
              '<span class="item-name" title="' + esc(item.filename.replace(/.md$/i, '')) + '">' + esc(item.filename.replace(/.md$/i, '')) + (item.hasUpdate ? '<span class="update-dot" title="Update available"></span>' : '') + '</span>' +
              '<span class="item-sub" title="' + esc(item.name) + '">' + esc(item.name) + '</span>' +
            '</span>' +
            '<span class="item-acts">' + actsHtml + '</span>' +
            '</div>';
        }).join('')
      : '<span class="empty">' + (q ? 'No items match "' + esc(q) + '"' : 'No items') + '</span>';

    const tagFiltersHtml = allTags.length
      ? '<div class="tag-filters">' +
          allTags.map(t =>
            '<button class="tag-chip' + (libActiveTags.has(t) ? ' active' : '') + '" type="button" data-tag="' + esc(t) + '">' + esc(t) + '</button>'
          ).join('') +
        '</div>'
      : '';

    panel.innerHTML =
      '<div class="lib-panel">' +
        tabsHtml +
        tagFiltersHtml +
        '<div class="box-search"><input class="search" id="lib-search" type="text" placeholder="Filter ' + libActiveTab + '…" autocomplete="off" spellcheck="false" value="' + esc(q) + '"></div>' +
        itemsHtml +
      '</div>';

    panel.querySelectorAll('[data-lib-tab]').forEach(tab => {
      tab.onclick = () => {
        libActiveTab = tab.getAttribute('data-lib-tab');
        libQuery = '';
        libActiveTags = new Set(); // reset tags on tab switch
        saveSidebarState();
        renderDefaultsPanel();
      };
    });

    panel.querySelectorAll('[data-tag]').forEach(chip => {
      chip.onclick = () => {
        const tag = chip.getAttribute('data-tag');
        if (libActiveTags.has(tag)) libActiveTags.delete(tag);
        else libActiveTags.add(tag);
        saveSidebarState();
        renderDefaultsPanel();
      };
    });

    const searchEl = document.getElementById('lib-search');
    if (searchEl) {
      searchEl.addEventListener('input', e => {
        libQuery = e.target.value.trim().toLowerCase();
        renderDefaultsPanel();
      });
    }

    panel.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = () => {
        const act = btn.getAttribute('data-act');
        const kind = btn.getAttribute('data-kind');
        const filename = btn.getAttribute('data-filename');
        const opLabel = act === 'installDefault' ? 'installing' : act === 'updateDefault' ? 'updating' : 'removing';
        libPendingOps.set(filename, opLabel);
        renderDefaultsPanel();
        vscode.postMessage({ type: act === 'installDefault' ? 'installDefaultItem' : act === 'updateDefault' ? 'updateDefaultItem' : 'uninstallDefaultItem', kind, filename });
      };
    });
  }

  const MCP_STATUS = {
    'connected':  { color: 'var(--vscode-charts-green, #73c991)',   label: 'Connected',  rank: 0 },
    'needs-auth': { color: 'var(--vscode-charts-yellow, #d7a000)',  label: 'Needs auth', rank: 1 },
    'unknown':    { color: 'var(--muted, #888)',                     label: 'Unknown',    rank: 2 },
    'failed':     { color: 'var(--vscode-charts-red, #f48771)',     label: 'Failed',     rank: 3 }
  };

  function setMcpData(list) {
    mcpServers = (list || []).slice();
    renderMcp();
    gitnexusConnected = mcpServers.some(s => s.status === 'connected' && s.name.toLowerCase().includes('gitnexus'));
    updateGitnexusRow();
  }

  // GitNexus row state: visibility gated by MCP connection, content driven by index status.
  let gitnexusConnected = false;
  let gitnexusStatus = { indexed: false, stale: false, files: 0, indexedAt: null, registryName: null, groups: [], currentGroup: null, currentAlias: null };

  function gxRelTime(iso) {
    const d = new Date(iso); if (isNaN(d.getTime())) return '';
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 90) return 'just now';
    const m = s / 60; if (m < 90) return Math.round(m) + 'm ago';
    const h = m / 60; if (h < 36) return Math.round(h) + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  // True while an analyze/group/clean run is in flight — set by 'gitnexusAnalyzeStarted', cleared
  // when the next real status ('data'/'gitnexusStatus') arrives. Drives the transient "Analyzing…" row.
  let gitnexusAnalyzing = false;

  // Single merged GitNexus row. Shown ONLY once the GitNexus MCP server is connected — connecting
  // is a one-time global setup handled in the Overview panel. Once connected, this row drives the
  // per-repo index lifecycle: analyzing → not-indexed (Analyze) → stale (Re-analyze) → up to date.
  function updateGitnexusRow() {
    const row = document.getElementById('gitnexus-setting-row');
    const dot = document.getElementById('gitnexus-dot');
    const desc = document.getElementById('gitnexus-desc');
    const btn = document.getElementById('gitnexus-analyze-btn');
    const menuPop = document.getElementById('gitnexus-menu-pop');
    if (!row || !dot || !desc || !btn || !menuPop) return;

    // Gated on the MCP connection: until GitNexus is connected (set up in Overview) there's nothing
    // to query, so the row stays hidden and Overview owns the "connect" step.
    row.style.display = gitnexusConnected ? '' : 'none';
    if (!gitnexusConnected) return;

    const indexed = gitnexusStatus.indexed;
    const stale = gitnexusStatus.stale;

    // ---- Transient: a run is in flight ----
    if (gitnexusAnalyzing) {
      dot.style.display = 'none';
      desc.textContent = 'Analyzing…';
      btn.style.display = ''; btn.disabled = true; btn.textContent = 'Analyzing…';
      menuPop.innerHTML = '';
      return;
    }
    btn.disabled = false;

    const parts = [];
    if (gitnexusStatus.files) parts.push(gitnexusStatus.files + ' files');
    const t = gxRelTime(gitnexusStatus.indexedAt);
    if (t) parts.push('indexed ' + t);
    const grp = gitnexusStatus.currentGroup ? ' · group: ' + gitnexusStatus.currentGroup : '';
    const meta = (parts.length ? ' · ' + parts.join(' · ') : '') + grp;
    const AMBER = 'var(--vscode-charts-yellow, #d7a000)';

    if (!indexed) {
      // Never analyzed → Analyze is the primary action; group choice lives in the ··· menu.
      dot.style.display = 'none';
      desc.textContent = 'Not indexed — click Analyze (or pick a group from ···)';
      btn.style.display = ''; btn.textContent = 'Analyze';
    } else if (stale) {
      // Indexed but code moved on (new commit, branch switch, or an edit since analyze) → re-analyze.
      dot.style.display = 'inline-block'; dot.style.background = AMBER;
      desc.textContent = 'Out of date — re-analyze recommended' + meta;
      btn.style.display = ''; btn.textContent = 'Re-analyze';
    } else {
      // Indexed and fresh → nothing to do; re-analyze still available from the ··· menu.
      dot.style.display = 'inline-block'; dot.style.background = 'var(--success)';
      desc.textContent = 'Up to date' + meta;
      btn.style.display = 'none';
    }

    // ··· menu: Re-analyze + the full Group picker (join/switch/leave/create) + file/clean actions.
    // Group management lives here (not on the row) so Analyze stays the single primary action outside.
    const current = gitnexusStatus.currentGroup || 'default';
    const groups = gitnexusStatus.groups || [];
    // Built as raw HTML (not menuItem, which escapes its label) so the ✓ marker renders.
    const groupItem = (value, label) =>
      '<button class="menu-item" type="button" data-act="group" data-group="' + esc(value) + '">' +
        '<span class="mi-check">' + (value === current ? '✓' : '') + '</span>' + esc(label) + '</button>';

    const items = [];
    if (indexed) items.push(menuItem('Re-analyze', 'data-act="analyze"'));
    items.push('<div class="menu-label">Group</div>');
    items.push(groupItem('default', 'Default (no group)'));
    groups.forEach(g => items.push(groupItem(g, g)));
    items.push(menuItem('＋ Create new group…', 'data-act="createGroup"'));
    items.push('<div class="menu-sep"></div>');
    items.push(menuItem('Open registry file', 'data-act="openRegistry"'));
    if (indexed && gitnexusStatus.currentGroup) items.push(menuItem('Open group config', 'data-act="openGroup"'));
    if (indexed) items.push(menuItem('Remove analyze', 'data-act="clean"', true));
    menuPop.innerHTML = items.join('');
  }

  function renderMcp() {
    const el = document.getElementById('mcp');
    const connected = mcpServers.filter(s => s.status === 'connected').length;
    document.getElementById('conn-count').textContent = connected ? String(connected) : '';
    const q = mcpQuery;

    if (!mcpServers.length) {
      el.innerHTML = '<span class="empty">No MCP connections installed</span>';
      return;
    }
    const rows = mcpServers
      .filter(s => activeMcpTab === 'installed' ? s.status === 'connected' : s.status !== 'connected')
      .filter(s => !q || s.name.toLowerCase().includes(q))
      .sort((a, b) =>
        (MCP_STATUS[a.status] || MCP_STATUS.unknown).rank - (MCP_STATUS[b.status] || MCP_STATUS.unknown).rank
        || a.name.localeCompare(b.name));
    if (activeMcpTab === 'installed' && !connected) {
      el.innerHTML = '<span class="empty">No MCP connections installed</span>';
      return;
    }
    if (activeMcpTab === 'available' && !mcpServers.some(s => s.status !== 'connected')) {
      el.innerHTML = '<span class="empty">No available MCP connections</span>';
      return;
    }
    if (!rows.length) {
      el.innerHTML = '<span class="empty">No match for &ldquo;' + esc(q) + '&rdquo;</span>';
      return;
    }
    el.innerHTML = rows.map(s => {
      const st = MCP_STATUS[s.status] || MCP_STATUS.unknown;
      const tgt = s.target || '';
      const isHttp = tgt.toLowerCase().startsWith('http://') || tgt.toLowerCase().startsWith('https://') || tgt.toUpperCase().endsWith('(HTTP)');
      const isClaudeAi = s.name.startsWith('claude.ai ');
      const canReconnect = (s.status === 'failed' || s.status === 'needs-auth') && tgt && isHttp && !isClaudeAi;
      const canBrowserAuth = isClaudeAi && s.status === 'needs-auth';
      const canRetryLocal = s.status === 'failed' && !isHttp && !isClaudeAi;
      return '<div class="item">' +
        '<span class="item-dot" title="' + esc(s.status) + '" style="background:' + st.color + '"></span>' +
        '<span class="item-body">' +
          '<span class="item-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
          '<span class="item-sub">' + esc(st.label) + '</span>' +
        '</span>' +
        '<span class="item-acts">' +
          '<button class="pill" type="button" data-act="mcpDetails" data-name="' + esc(s.name) + '">Details</button>' +
          (canReconnect
            ? '<button class="pill accent" type="button" data-act="mcpReconnect" data-name="' + esc(s.name) + '" data-target="' + esc(tgt) + '">' +
              (s.status === 'failed' ? 'Retry' : 'Auth') + '</button>'
            : '') +
          (canBrowserAuth
            ? '<button class="pill accent" type="button" data-act="openExternal" data-url="https://claude.ai" title="Authenticate via claude.ai">Auth</button>'
            : '') +
          (canRetryLocal
            ? '<button class="pill accent" type="button" data-act="refresh" title="Re-probe this server">Retry</button>'
            : '') +
        '</span>' +
        '</div>';
    }).join('');
    bindActionButtons(el);
  }

  function setPluginData(installed, available) {
    installedPlugins = installed || [];
    availablePlugins = available || [];
    renderPlugins();
  }

  function renderPanelError(id, label) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<span class="empty">' + esc(label) + ' unavailable</span>';
  }

  function renderPlugins() {
    const el = document.getElementById('plugins');
    document.getElementById('plug-count').textContent = installedPlugins.length ? String(installedPlugins.length) : '';
    const q = pluginQuery;

    if (activePluginTab === 'installed') {
      const rows = installedPlugins.filter(p => !q || p.name.toLowerCase().includes(q));
      if (!installedPlugins.length) { el.innerHTML = '<span class="empty">No plugins installed</span>'; return; }
      if (!rows.length) { el.innerHTML = '<span class="empty">No match for &ldquo;' + esc(q) + '&rdquo;</span>'; return; }
      el.innerHTML = rows.map(p =>
        '<div class="item">' +
        '<span class="item-dot" title="' + (p.enabled ? 'Enabled' : 'Disabled') + '" style="background:' +
          (p.enabled ? 'var(--vscode-charts-green, #73c991)' : 'var(--vscode-charts-red, #f48771)') + '"></span>' +
        '<span class="item-body">' +
          '<span class="item-name" title="' + esc(p.name) + ' · v' + esc(p.version) + '">' + esc(p.name) + '</span>' +
          '<span class="item-sub">' + esc(p.scope) + ' · v' + esc(p.version) + '</span>' +
        '</span>' +
        '<span class="item-acts">' +
          '<button class="pill" type="button" data-act="details" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Details</button>' +
          actionMenu([
            menuItem(p.enabled ? 'Disable' : 'Enable', 'data-act="toggle" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '" data-enable="' + !p.enabled + '"'),
            menuItem('Update', 'data-act="update" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '"'),
            menuItem('Uninstall', 'data-act="uninstall" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '"', true)
          ]) +
        '</span>' +
        '</div>'
      ).join('');
    } else {
      const rows = availablePlugins.filter(p => !q || p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
      if (!availablePlugins.length) { el.innerHTML = '<span class="empty">No marketplace configured</span>'; return; }
      if (!rows.length) { el.innerHTML = '<span class="empty">No match for &ldquo;' + esc(q) + '&rdquo;</span>'; return; }
      el.innerHTML = rows.map(p =>
        '<div class="item">' +
        '<span class="item-dot" style="background:var(--muted)"></span>' +
        '<span class="item-body">' +
          '<span class="item-name" title="' + esc(p.id) + '">' + esc(p.name) + '</span>' +
          '<span class="item-sub" title="' + esc(p.description || p.id) + '">' + esc(p.description || p.id) + '</span>' +
        '</span>' +
        '<span class="item-acts">' +
          '<button class="pill accent" type="button" data-act="install" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">Install</button>' +
        '</span>' +
        '</div>'
      ).join('');
    }
    bindActionButtons(el);
  }

  function bindActionButtons(root) {
    root.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = () => {
        const act = btn.getAttribute('data-act');
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-name');
        const locks = ['install', 'update', 'uninstall', 'toggle', 'mcpReconnect', 'deleteRun'].includes(act);
        const menu = btn.closest('.menu');
        if (menu) menu.open = false;

        if (locks) {
          btn.closest('.item')?.querySelectorAll('button').forEach(b => b.disabled = true);
          const label = act === 'install' ? 'Installing…' : act === 'update' ? 'Updating…'
            : act === 'uninstall' ? 'Removing…' : act === 'mcpReconnect' ? 'Connecting…'
            : act === 'deleteRun' ? 'Deleting…' : '…';
          btn.innerHTML = spinHtml + label;
        } else {
          // Transient operations: show spinner briefly, auto-restore after 1.5 s
          const prev = btn.innerHTML;
          btn.disabled = true;
          btn.innerHTML = spinHtml + btn.textContent.trim();
          setTimeout(() => { btn.disabled = false; btn.innerHTML = prev; }, 1500);
        }

        if (act === 'toggle') vscode.postMessage({ type: 'togglePlugin', pluginId: id, pluginName: name, enable: btn.getAttribute('data-enable') === 'true' });
        else if (act === 'install') vscode.postMessage({ type: 'installPlugin', pluginId: id, pluginName: name });
        else if (act === 'update') vscode.postMessage({ type: 'updatePlugin', pluginId: id, pluginName: name });
        else if (act === 'details') vscode.postMessage({ type: 'pluginDetails', pluginId: id, pluginName: name });
        else if (act === 'uninstall') vscode.postMessage({ type: 'uninstallPlugin', pluginId: id, pluginName: name });
        else if (act === 'mcpReconnect') vscode.postMessage({ type: 'reconnectMcp', mcpName: name, mcpTarget: btn.getAttribute('data-target') });
        else if (act === 'mcpDetails') vscode.postMessage({ type: 'mcpDetails', mcpName: name });
        else if (act === 'openRun') vscode.postMessage({ type: 'openRun', flowId: btn.getAttribute('data-flow-id'), runId: btn.getAttribute('data-run-id') });
        else if (act === 'openFile') vscode.postMessage({ type: 'openFile', path: btn.getAttribute('data-path') });
        else if (act === 'deleteRun') vscode.postMessage({ type: 'deleteRun', path: btn.getAttribute('data-path') });
        else if (act === 'openExternal') vscode.postMessage({ type: 'openExternal', url: btn.getAttribute('data-url') });
        else if (act === 'refresh') vscode.postMessage({ type: 'refresh' });
      };
    });
  }

  function bindRowClicks(root) {
    root.querySelectorAll('.item[data-row-act]').forEach(row => {
      row.style.cursor = 'pointer';
      row.onclick = e => {
        if (e.target.closest('button, details, .menu')) return;
        const act = row.getAttribute('data-row-act');
        if (act === 'openOverview') vscode.postMessage({ type: 'openOverview' });
        else if (act === 'openFile') vscode.postMessage({ type: 'openFile', path: row.getAttribute('data-row-path') });
      };
    });
  }

  function renderRuns(files, total) {
    lastRunFiles = files || [];
    lastRunTotal = total || 0;
    const el = document.getElementById('runs');
    const totalCount = total || 0;
    document.getElementById('runs-count').textContent = totalCount ? String(totalCount) : '';

    if (!files || !files.length) {
      el.innerHTML = '<span class="empty">No runs yet</span>';
      return;
    }

    const filteredFiles = runsQuery
      ? files.filter(f => (f.runName || f.flowName || '').toLowerCase().includes(runsQuery))
      : files;

    if (!filteredFiles.length) {
      el.innerHTML = '<span class="empty">No runs match "' + esc(runsQuery) + '"</span>';
      return;
    }

    el.innerHTML = filteredFiles.map(f => {
      const isActive = !!f.isActive;
      const isFinalized = !!f.isClosed;
      const reviewing = !!f.reviewing;
      const isDone = f.completed === f.total && f.total > 0;
      // Count the in-flight step (running or under review) toward the tally so a step in progress
      // shows its own position, e.g. "2/5" while step 2 is running/being reviewed.
      const shown = Math.min(f.completed + (f.inProgress || 0), f.total);
      const isPartial = f.completed > 0 && !isDone;
      const percent = f.total > 0 ? Math.round((shown / f.total) * 100) : 0;
      const cardCls = reviewing ? ' run-reviewing' : isActive ? ' run-active' : (isDone ? ' run-done' : '');
      const badgeCls = isFinalized ? 'done' : isDone ? 'done' : reviewing ? 'reviewing' : isActive ? 'running' : isPartial ? 'partial' : '';
      const badgeLabel = isFinalized ? '✓ Finalized' : isDone ? '✓ Done' : reviewing ? 'Reviewing' : isActive ? 'Active' : shown + '/' + f.total;
      return '<div class="run-card' + cardCls + '">' +
        '<div class="run-card-head">' +
          '<div class="run-card-titles">' +
            '<div class="run-card-title" title="' + esc(f.runName || f.flowName) + '">' + esc(f.runName || f.flowName) + '</div>' +
            (f.runName ? '<div class="run-card-sub" title="' + esc(f.flowName) + '">' + esc(f.flowName) + '</div>' : '') +
          '</div>' +
          (badgeCls ? '<span class="run-sbadge ' + badgeCls + '">' + badgeLabel + '</span>' : '') +
          '<span class="run-card-acts">' +
            actionMenu([
              menuItem('Open runs', 'data-act="openRun" data-flow-id="' + esc(f.flowId) + '" data-run-id="' + esc(f.runId) + '"'),
              menuItem('View run file', 'data-act="openFile" data-path="' + esc(f.filePath) + '"'),
              menuItem('Delete run', 'data-act="deleteRun" data-path="' + esc(f.filePath) + '"', true)
            ]) +
          '</span>' +
        '</div>' +
        '<div class="run-card-bar"><div class="run-card-bar-fill" style="width:' + percent + '%"></div></div>' +
        '<div class="run-card-foot">' +
          '<span class="run-card-meta">' + fmtDate(f.runId) + '</span>' +
          '<span class="run-card-meta">' + shown + '/' + f.total + ' steps</span>' +
        '</div>' +
      '</div>';
    }).join('');
    bindActionButtons(el);
  }

  // Async probes arrive after first paint — keep skeletons up until each lands.
  let mcpReceived = false, pluginsReceived = false;

  window.addEventListener('message', e => {
    try {
      const m = e.data;
      if (m.type === 'data') {
        restoreSidebarState(m.uiPrefs);
        ['mcp', 'plugins', 'runs', 'settings'].forEach(k => _applySection(k, sectionOpen[k]));
        document.getElementById('loading-overlay').style.display = 'none';
        renderStats(m.stats);
        renderDefaults(m.defaultItems || []);
        finishRefresh();
        mcpReceived = true;
        pluginsReceived = true;
        if (m.gitnexus) gitnexusStatus = m.gitnexus;
        gitnexusAnalyzing = false; // a full refresh means any in-flight run has finished
        setMcpData(m.mcp);
        setPluginData(m.plugins, m.pluginsAvailable);
        renderRuns(m.runFiles, m.totalRunFiles);
        const styleSelect = document.getElementById('ai-style-select');
        if (styleSelect && m.uiPrefs) styleSelect.value = m.uiPrefs['ai:responseStyle'] || 'default';
        renderReviewKits(m.reviewKits || [], (m.uiPrefs || {})['review:activeKit'] || '');
        renderAccounts(m.accounts);
      } else if (m.type === 'mcp') {
        mcpReceived = true;
        setMcpData(m.mcp);
      } else if (m.type === 'plugins') {
        pluginsReceived = true;
        setPluginData(m.plugins, m.pluginsAvailable);
      } else if (m.type === 'gitnexusAnalyzeStarted') {
        gitnexusAnalyzing = true;
        updateGitnexusRow();
      } else if (m.type === 'gitnexusStatus') {
        // Lightweight status push — used to reset the select after a cancelled group switch.
        gitnexusAnalyzing = false;
        if (m.status) { gitnexusStatus = m.status; updateGitnexusRow(); }
      }
    } catch (err) {
      console.error('ClaudeSteps sidebar render failed', err);
      renderPanelError('mcp', 'Connections');
      renderPanelError('plugins', 'Plugins');
    }
  });

  document.getElementById('ai-style-select').addEventListener('change', function() {
    vscode.postMessage({ type: 'savePref', key: 'ai:responseStyle', value: this.value });
  });

  // Populate the review-kit picker from installed kits; value is the kit filename
  // ('' = fall back to the bundled default). Selection persists as a project ui-pref.
  function renderReviewKits(kits, active) {
    const sel = document.getElementById('review-kit-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">Default</option>' +
      kits.map(k => '<option value="' + esc(k.file) + '">' + esc(k.name) +
        (k.scope === 'global' ? ' (global)' : '') + '</option>').join('');
    sel.value = kits.some(k => k.file === active) ? active : '';
  }

  document.getElementById('review-kit-select').addEventListener('change', function() {
    vscode.postMessage({ type: 'savePref', key: 'review:activeKit', value: this.value });
  });

  // Populate the account switcher. accounts === null => unsupported platform (hide the row).
  function renderAccounts(accounts) {
    const row = document.getElementById('account-setting-row');
    const sel = document.getElementById('account-select');
    if (!row || !sel) return;
    if (accounts == null) { row.style.display = 'none'; return; }
    row.style.display = '';
    if (!accounts.length) {
      sel.innerHTML = '<option value="" disabled selected>No saved accounts</option>';
      return;
    }
    const hasActive = accounts.some(a => a.active);
    const placeholder = hasActive ? '' : '<option value="" disabled selected>&#8212; external login &#8212;</option>';
    const options = accounts.map(a =>
      '<option value="' + esc(a.name) + '"' + (a.active ? ' selected data-active="1"' : '') + '>' + esc(a.email) + '</option>'
    ).join('');
    // Switch-only: there is no manual remove action — logging out of an account auto-removes it.
    sel.innerHTML = placeholder + options;
  }

  document.getElementById('account-select').addEventListener('change', function() {
    if (this.value) vscode.postMessage({ type: 'accountSwitch', name: this.value });
  });

  document.getElementById('gitnexus-analyze-btn').addEventListener('click', function() {
    gitnexusAnalyzing = true; // immediate feedback; the extension also posts gitnexusAnalyzeStarted
    updateGitnexusRow();
    vscode.postMessage({ type: 'gitnexusAnalyze' }); // plain analyze; group is chosen from the ··· menu
  });

  document.getElementById('gitnexus-menu-pop').addEventListener('click', function(e) {
    const item = e.target instanceof Element ? e.target.closest('[data-act]') : null;
    if (!item) return;
    const menu = document.getElementById('gitnexus-menu');
    if (menu) menu.open = false;
    const act = item.getAttribute('data-act');
    if (act === 'analyze') { gitnexusAnalyzing = true; updateGitnexusRow(); vscode.postMessage({ type: 'gitnexusAnalyze' }); }
    else if (act === 'createGroup') vscode.postMessage({ type: 'gitnexusCreateGroup' });
    else if (act === 'group') {
      const group = item.getAttribute('data-group') || 'default';
      const current = gitnexusStatus.currentGroup || 'default';
      if (group === current) return; // already in this group — no-op
      if (!gitnexusStatus.indexed) {
        // Pre-index: analyze straight into the chosen group in one pass (analyze + join).
        gitnexusAnalyzing = true; updateGitnexusRow();
        vscode.postMessage({ type: 'gitnexusAnalyze', group });
      } else {
        // Indexed: switch/leave group (confirms in the extension; re-analyzes only if stale).
        vscode.postMessage({ type: 'gitnexusSelectGroup', group });
      }
    }
    else if (act === 'openRegistry') vscode.postMessage({ type: 'gitnexusOpenRegistry' });
    else if (act === 'openGroup') vscode.postMessage({ type: 'gitnexusOpenGroup' });
    else if (act === 'clean') vscode.postMessage({ type: 'gitnexusClean' });
  });
</script>
</body>
</html>`;
}
