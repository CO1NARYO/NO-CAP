// lib/db.js — one tiny interface over two Postgres drivers:
//   production: Neon (Vercel Marketplace) over HTTP, using DATABASE_URL
//   local/tests: PGlite, an in-process Postgres (a dev dependency)
// Every query goes through db.query(text, params) and resolves to an array of rows.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id text PRIMARY KEY,
     email text UNIQUE NOT NULL,
     name text NOT NULL,
     pass_hash text NOT NULL,
     created_at double precision NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS auth_sessions (
     token_hash text PRIMARY KEY,
     user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at double precision NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS exams (
     id text PRIMARY KEY,
     user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     title text NOT NULL,
     form_url text NOT NULL DEFAULT '',
     code text UNIQUE NOT NULL,
     open boolean NOT NULL DEFAULT true,
     policy jsonb NOT NULL,
     created_at double precision NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS exams_user ON exams(user_id)`,
  `CREATE TABLE IF NOT EXISTS students (
     id text PRIMARY KEY,
     exam_id text NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
     name text NOT NULL,
     student_id text NOT NULL DEFAULT '',
     token_hash text UNIQUE NOT NULL,
     joined_at double precision NOT NULL,
     consent_at double precision NOT NULL,
     last_seen_at double precision NOT NULL,
     updated_at double precision NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS students_exam ON students(exam_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS exam_sessions (
     student_id text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
     session_id text NOT NULL,
     data jsonb NOT NULL,
     started_at double precision NOT NULL,
     PRIMARY KEY (student_id, session_id)
   )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
     key text PRIMARY KEY,
     count int NOT NULL,
     reset_at double precision NOT NULL
   )`
];

export async function ensureSchema(db) {
  for (const statement of SCHEMA) await db.query(statement, []);
}

/**
 * Open a database.
 *   { url }       -> Neon over HTTP
 *   { localDir }  -> PGlite stored in that folder (or ':memory:')
 */
export async function createDb({ url, localDir } = {}) {
  let db;
  if (url) {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(url);
    db = { query: async (text, params = []) => sql.query(text, params), close: async () => {} };
  } else if (localDir) {
    let PGlite;
    try {
      ({ PGlite } = await import('@electric-sql/pglite'));
    } catch {
      throw new Error('Local mode needs the dev dependency. Run "npm install" in the dashboard folder first.');
    }
    const pg = localDir === ':memory:' ? new PGlite() : new PGlite(localDir);
    await pg.waitReady;
    db = { query: async (text, params = []) => (await pg.query(text, params)).rows, close: () => pg.close() };
  } else {
    throw new Error('No database configured. Set DATABASE_URL (see README).');
  }
  if (process.env.SKIP_MIGRATE !== '1') await ensureSchema(db);
  return db;
}

let shared;
/** Lazily open the production database once per serverless instance. */
export function getSharedDb(env = process.env) {
  shared ||= createDb({ url: env.DATABASE_URL || env.POSTGRES_URL }).catch((err) => {
    shared = undefined; // let the next request retry
    throw err;
  });
  return shared;
}
