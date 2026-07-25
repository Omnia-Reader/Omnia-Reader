import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import {
  WEB_APPLICATION_SHELL_HEADERS,
  WEB_SECURITY_HEADERS,
} from './web-security-headers.mjs';

const [rootArgument = 'dist/apps/omnia-reader/browser', portArgument = '4200'] =
  process.argv.slice(2);
const root = resolve(process.cwd(), rootArgument);
const port = Number.parseInt(portArgument, 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid port: ${portArgument}`);
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function safePath(requestUrl) {
  const pathname = decodeURIComponent(
    new URL(requestUrl, 'http://localhost').pathname,
  );
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const candidate = resolve(root, requested);

  if (
    isAbsolute(requested) ||
    (candidate !== root && !candidate.startsWith(`${root}${sep}`))
  ) {
    return undefined;
  }

  return candidate;
}

async function regularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  const writeHead = (status, headers = {}) =>
    response.writeHead(status, { ...WEB_SECURITY_HEADERS, ...headers });

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  const requestedPath = safePath(request.url ?? '/');
  if (!requestedPath) {
    writeHead(400);
    response.end();
    return;
  }

  const filePath = (await regularFile(requestedPath))
    ? requestedPath
    : resolve(root, 'index.html');

  if (!(await regularFile(filePath))) {
    writeHead(404);
    response.end();
    return;
  }

  writeHead(200, {
    ...(filePath === resolve(root, 'index.html')
      ? WEB_APPLICATION_SHELL_HEADERS
      : {}),
    'Cache-Control': 'no-store',
    'Content-Type':
      contentTypes.get(extname(filePath).toLowerCase()) ??
      'application/octet-stream',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Serving ${root} at http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
