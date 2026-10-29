'use strict';

/**
 * A tiny loopback static server.
 *
 * The renderers need a real http origin: YouTube rejects an embedded player
 * whose parent page is file:// with error 153. Serving the same files from
 * 127.0.0.1 gives the page a normal origin and Referer. Only the two renderer
 * trees and bundled assets are exposed; the server binds to loopback and uses
 * an ephemeral port.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const ALLOWED_PREFIXES = ['/src/renderer/', '/assets/'];

function safeFilePath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (!ALLOWED_PREFIXES.some((prefix) => decoded.startsWith(prefix))) return null;
  const resolved = path.resolve(root, '.' + decoded);
  const rootWithSep = path.resolve(root) + path.sep;
  if (!resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

function start(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end('Method not allowed');
        return;
      }

      let pathname = '/';
      try {
        pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      } catch (_) {
        response.writeHead(400);
        response.end('Bad request');
        return;
      }

      if (pathname === '/') pathname = '/src/renderer/panel/index.html';
      if (pathname === '/wallpaper') pathname = '/src/renderer/wallpaper/index.html';
      if (pathname === '/panel') pathname = '/src/renderer/panel/index.html';

      const filePath = safeFilePath(root, pathname);
      if (!filePath) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }

      fs.stat(filePath, (statError, stat) => {
        if (statError || !stat.isFile()) {
          response.writeHead(404);
          response.end('Not found');
          return;
        }
        const extension = path.extname(filePath).toLowerCase();
        response.writeHead(200, {
          'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        if (request.method === 'HEAD') {
          response.end();
          return;
        }
        const stream = fs.createReadStream(filePath);
        stream.on('error', () => {
          response.destroy();
        });
        stream.pipe(response);
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: address.port, origin: 'http://127.0.0.1:' + address.port });
    });
  });
}

module.exports = { start };
