import { createServer } from 'http';
import { createReadStream, existsSync, statSync } from 'fs';
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

const server = createServer((request, response) => {
  const activePort = server.address()?.port || preferredPort;
  const url = new URL(request.url || '/', `http://localhost:${activePort}`);
  const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = normalize(join(root, requestedPath));

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
    console.log(`AI StepFlow webview preview: http://${host}:${activePort}`);
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
