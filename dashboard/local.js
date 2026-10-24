// local.js — run the exact same backend on your own computer (no Vercel, no Neon needed).
//   npm install
//   npm run dev
// Data is stored in ./data (an in-process Postgres). Also used by the automated tests.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHandler } from './lib/app.js';
import { createDb } from './lib/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/shared.js': ['shared.js', 'text/javascript; charset=utf-8']
};

export async function createLocalServer({ localDir = path.join(HERE, 'data'), env = process.env } = {}) {
  const db = await createDb({ localDir });
  const handler = createHandler({ getDb: async () => db, env });
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (STATIC[p] && req.method === 'GET') {
      const [file, type] = STATIC[p];
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, file)));
    }
    return handler(req, res);
  });
  return {
    db,
    server,
    listen: (port, host) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    close: async () => {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await db.close();
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '127.0.0.1';
  const app = await createLocalServer({ localDir: process.env.LOCAL_DB_DIR || path.join(HERE, 'data') });
  const addr = await app.listen(port, host);
  console.log(`NO CAP dashboard (local mode) running at http://${host}:${addr.port}`);
  console.log('Create an instructor account on the sign-in page. Data is stored in ./data.');
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
