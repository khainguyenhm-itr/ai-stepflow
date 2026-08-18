import { createServer } from 'http';
import { createReadStream, existsSync, statSync, readFileSync } from 'fs';
import { extname, join, normalize } from 'path';

const root = join(process.cwd(), 'packages', 'extension', 'out', 'webview');
const preferredPort = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

// ---------------------------------------------------------------------------
// Sidebar preview: extract HTML from sidebarProvider.ts and patch for browser
// ---------------------------------------------------------------------------
function buildSidebarHtml() {
  const src = readFileSync(
    join(process.cwd(), 'packages', 'extension', 'src', 'sidebarHtml.ts'),
    'utf8'
  );
  const lines = src.split('\n');

  const startIdx = lines.findIndex(l => l.trimStart().startsWith('return /* html */'));
  const endIdx   = lines.findIndex(l => l.trim() === '</html>`;');
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('Cannot locate sidebar HTML template in sidebarProvider.ts');
  }

  let html = lines.slice(startIdx, endIdx + 1).join('\n');
  // Strip the JS wrapper
  html = html.replace(/^\s*return \/\* html \*\/ `/, '');
  html = html.replace(/`;\s*$/, '');

  // Remove CSP restriction (inline styles + scripts must work in browser)
  html = html.replace('content="${csp}"', 'content="default-src * \'unsafe-inline\'"');
  // Replace version interpolation
  html = html.replace(
    '${version ? `<span class="ver">v${version}</span>` : \'\'}',
    '<span class="ver">preview</span>'
  );
  // Remove nonce attribute
  html = html.replace(' nonce="${nonce}"', '');

  // Mock acquireVsCodeApi so sidebar JS runs without VS Code host
  const mockApi = [
    'window.acquireVsCodeApi = () => ({',
    '  postMessage: msg => console.info(\'[preview→host]\', JSON.stringify(msg)),',
    '  getState: () => ({}),',
    '  setState: () => {}',
    '});',
  ].join('\n  ');
  html = html.replace(
    'const vscode = acquireVsCodeApi();',
    mockApi + '\n  const vscode = acquireVsCodeApi();'
  );

  // Inject mock data on load so all sections render with sample content
  const mockData = `
  window.addEventListener('load', () => {
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'data',
      stats: { flows: 2, agents: 3, skills: 6 },
      defaultItems: [
        { name: 'csf-agent-developer', kind: 'agents', description: 'Senior software engineer agent', installed: true,  inUse: true,  filename: 'csf-agent-developer.md' },
        { name: 'csf-agent-qa',        kind: 'agents', description: 'QA engineer agent',              installed: false, inUse: false, filename: 'csf-agent-qa.md' },
        { name: 'csf-skill-implement', kind: 'skills', description: 'Implement features or fixes',    installed: true,  inUse: false, filename: 'csf-skill-implement.md' },
        { name: 'csf-skill-review',    kind: 'skills', description: 'Review code changes',            installed: false, inUse: false, filename: 'csf-skill-review.md' }
      ],
      mcp: [
        { name: 'gitnexus',  status: 'needs-auth', type: 'local', transport: 'stdio' }
      ],
      plugins: [],
      pluginsAvailable: [
        { id: 'gitnexus', name: 'GitNexus', description: 'Code intelligence MCP', version: '1.0.0', installed: false }
      ],
      activeRun: {
        flowName: 'Preview Docs Flow',
        runName: 'run-2024-01',
        completed: 1,
        total: 5,
        percent: 40,
        isRunning: false,
        filePath: null,
        currentStep: { title: 'Write Docs', status: 'waiting_human' }
      },
      runFiles: [
        { flowId: 'preview-docs-flow', flowName: 'Preview Docs Flow', runId: '2026-07-15T02:30:00.000Z', runName: 'Preview run · docs', completed: 1, inProgress: 1, reviewing: true,  total: 5, filePath: '/preview/run-reviewing.json', isClosed: false, isActive: true },
        { flowId: 'preview-docs-flow', flowName: 'Preview Docs Flow', runId: '2026-07-14T09:10:00.000Z', runName: 'Nightly build',       completed: 3, inProgress: 1, reviewing: false, total: 5, filePath: '/preview/run-running.json',   isClosed: false, isActive: false },
        { flowId: 'preview-docs-flow', flowName: 'Preview Docs Flow', runId: '2026-07-13T18:00:00.000Z', runName: 'Release 1.0',          completed: 5, inProgress: 0, reviewing: false, total: 5, filePath: '/preview/run-done.json',      isClosed: false, isActive: false }
      ],
      totalRunFiles: 3,
      uiPrefs: { 'review:activeKit': 'csf-review-default.md' },
      reviewKits: [
        { name: 'CSF Review Default', file: 'csf-review-default.md', scope: 'global' },
        { name: 'Strict Security Review', file: 'strict-security.md', scope: 'project' }
      ]
    }}));
  });`;

  // Insert before the last </script> tag
  const lastScript = html.lastIndexOf('</script>');
  html = html.slice(0, lastScript) + mockData + '\n' + html.slice(lastScript);

  return html;
}

// Combined split-frame HTML
function buildFrameHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ClaudeSteps — Preview</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100vh; overflow: hidden; background: #1e1e1e; }
    .layout { display: flex; height: 100vh; }
    .sidebar-pane { width: 280px; flex-shrink: 0; border-right: 1px solid #3c3c3c; overflow: hidden; }
    .body-pane { flex: 1; min-width: 0; overflow: hidden; }
    iframe { border: 0; width: 100%; height: 100%; display: block; }
  </style>
  <script>
    let lastVersion = 0;
    setInterval(async () => {
      try {
        const res = await fetch('/_build-version');
        const data = await res.json();
        if (data.version > lastVersion && lastVersion > 0) {
          console.log('[live-reload] Build updated, refreshing...');
          location.reload();
        }
        lastVersion = data.version;
      } catch (e) {}
    }, 500);
  </script>
</head>
<body>
  <div class="layout">
    <div class="sidebar-pane"><iframe src="/sidebar" title="Sidebar"></iframe></div>
    <div class="body-pane"><iframe src="/app/" title="Webview"></iframe></div>
  </div>
</body>
</html>`;
}

// Cache sidebar HTML at startup
let sidebarHtml;
let buildVersion = 0;
try {
  sidebarHtml = buildSidebarHtml();
} catch (err) {
  console.warn('Sidebar preview unavailable:', err.message);
  sidebarHtml = `<html><body style="color:#ccc;background:#1e1e1e;padding:20px;font-family:sans-serif">
    <b>Sidebar preview unavailable</b><br><code>${err.message}</code>
  </body></html>`;
}

// Monitor webview build output for changes → bump version to force reload
import { watch } from 'fs';
watch(join(root), { recursive: true }, (evt, file) => {
  if (file?.endsWith('.js') || file?.endsWith('.css')) {
    buildVersion++;
    console.log(`[reload] Build changed (v${buildVersion})`);
  }
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = createServer((request, response) => {
  const activePort = server.address()?.port || preferredPort;
  const url = new URL(request.url || '/', `http://localhost:${activePort}`);
  const pathname = decodeURIComponent(url.pathname);

  // Reload API endpoint
  if (pathname === '/_build-version') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ version: buildVersion }));
    return;
  }

  // Combined preview (root)
  if (pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(buildFrameHtml());
    return;
  }

  // Sidebar panel
  if (pathname === '/sidebar') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(sidebarHtml);
    return;
  }

  // Webview app files: /app/... → serve from webview build root
  const appPrefix = '/app';
  let fileSuffix = pathname.startsWith(appPrefix)
    ? pathname.slice(appPrefix.length) || '/index.html'
    : pathname;
  if (fileSuffix === '' || fileSuffix === '/') fileSuffix = '/index.html';

  const filePath = normalize(join(root, fileSuffix));
  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': contentTypes.get(extname(filePath)) || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  createReadStream(filePath).pipe(response);
});

function listen(port, remainingAttempts = 10) {
  server.listen(port, host);

  server.once('listening', () => {
    const address = server.address();
    const activePort = typeof address === 'object' && address ? address.port : port;
    console.log(`ClaudeSteps preview: http://${host}:${activePort}`);
    console.log(`  sidebar only:      http://${host}:${activePort}/sidebar`);
    console.log(`  webview only:      http://${host}:${activePort}/app/`);
  });

  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && remainingAttempts > 0) {
      console.warn(`Port ${port} is in use; trying ${port + 1}.`);
      server.removeAllListeners('listening');
      listen(port + 1, remainingAttempts - 1);
      return;
    }
    throw error;
  });
}

listen(preferredPort);
