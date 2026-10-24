// Vercel serverless entry point. One catch-all function serves every /api/* route.
// (Static files in /public are served by Vercel itself.)
import { createHandler } from '../lib/app.js';
import { getSharedDb } from '../lib/db.js';

const handler = createHandler({ getDb: () => getSharedDb() });

export default function (req, res) {
  return handler(req, res);
}
