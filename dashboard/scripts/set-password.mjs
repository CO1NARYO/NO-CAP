// Operator tool: set a new password for an instructor who forgot theirs (there is no email reset).
//   DATABASE_URL="postgres://…" node scripts/set-password.mjs teacher@school.edu "a-new-long-password"
// For local mode use:  LOCAL_DB_DIR=./data node scripts/set-password.mjs …
import { createDb } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 10) {
  console.error('Usage: node scripts/set-password.mjs <email> <new password of at least 10 characters>');
  process.exit(1);
}
const db = await createDb(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : { localDir: process.env.LOCAL_DB_DIR || './data' });
const rows = await db.query(`UPDATE users SET pass_hash = $2 WHERE email = $1 RETURNING id`, [email.trim().toLowerCase(), await hashPassword(password)]);
if (!rows[0]) {
  console.error('No account with that email.');
  process.exit(1);
}
await db.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [rows[0].id]); // sign them out everywhere
console.log('Password updated and existing sign-ins ended.');
await db.close();
