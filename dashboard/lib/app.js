// lib/app.js — the whole backend as one plain Node (req, res) handler.
// The same handler runs on Vercel (api/[...path].js), locally (local.js) and in the tests.
//
// Serverless rules this code follows:
//   * no in-memory state between requests (sessions, rate limits and data live in Postgres)
//   * no long-lived connections (the dashboard polls /live instead of using SSE)
//   * no background timers (retention runs from a Vercel Cron call to /api/cron/purge)

import crypto from 'node:crypto';
import { HttpError, sanitizeSnapshot, sanitizePolicy, cleanFormUrl, cleanTitle, str } from './sanitize.js';
import { hashPassword, verifyPassword, burnVerify, randHex, sha256 } from './auth.js';
import { CATEGORY_META, isConfirmed, csvCell } from './shared.js';

const AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MAX_EXAMS_PER_USER = 100;
const MAX_STUDENTS_PER_EXAM = 2000;
const MAX_SESSIONS_PER_STUDENT = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
};
const corsStudent = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...securityHeaders,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

/** Read a JSON body. Vercel may already have parsed it into req.body, so honour that first. */
async function readJson(req, limit = 256 * 1024) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, 'Request too large.');
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
      const text = req.body.toString('utf8');
      if (text.length > limit) throw new HttpError(413, 'Request too large.');
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(400, 'Invalid JSON.');
      }
    }
    return req.body;
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, 'Request too large.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

const parseCookies = (req) =>
  Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((p) => p.trim().split('='))
      .filter((p) => p[0])
      .map(([k, ...v]) => [k, v.join('=')])
  );

const clientIp = (req) =>
  String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || 'unknown').trim();

const isSecure = (req) => req.headers['x-forwarded-proto'] === 'https' || !!req.socket?.encrypted;

const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

export function createHandler({ getDb, env = process.env }) {
  const retentionDays = env.RETENTION_DAYS === undefined || env.RETENTION_DAYS === '' ? 30 : Number(env.RETENTION_DAYS);
  const allowedDomains = String(env.ALLOWED_EMAIL_DOMAINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  const signupCode = String(env.INSTRUCTOR_SIGNUP_CODE || '');
  const cronSecret = String(env.CRON_SECRET || '');

  // ------------------------------------------------------------ helpers

  /** Fixed-window rate limit stored in Postgres so it works across serverless instances. */
  async function hit(db, key, limit, windowMs) {
    const now = Date.now();
    const rows = await db.query(
      `INSERT INTO rate_limits(key, count, reset_at) VALUES ($1, 1, $2::double precision)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at < $3::double precision THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at < $3::double precision THEN $2::double precision ELSE rate_limits.reset_at END
       RETURNING count`,
      [key, now + windowMs, now]
    );
    return Number(rows[0].count) <= limit;
  }
  async function limit(db, key, max, windowMs, message) {
    if (!(await hit(db, key, max, windowMs))) throw new HttpError(429, message || 'Too many attempts. Wait a few minutes and try again.');
  }

  async function currentUser(db, req) {
    const sid = parseCookies(req).nocap_sid;
    if (!sid) return null;
    const rows = await db.query(
      `SELECT u.id, u.email, u.name FROM auth_sessions a JOIN users u ON u.id = a.user_id
       WHERE a.token_hash = $1 AND a.expires_at > $2::double precision`,
      [sha256(sid), Date.now()]
    );
    return rows[0] || null;
  }

  async function requireTeacher(db, req) {
    const user = await currentUser(db, req);
    if (!user) throw new HttpError(401, 'Sign in required.');
    if (req.method !== 'GET') {
      if (req.headers['x-requested-with'] !== 'nocap') throw new HttpError(403, 'Missing request header.');
      const origin = req.headers.origin;
      if (origin) {
        let ok = false;
        try {
          ok = new URL(origin).host === req.headers.host;
        } catch {
          /* fall through */
        }
        if (!ok) throw new HttpError(403, 'Cross-origin request blocked.');
      }
    }
    return user;
  }

  function requireXrw(req) {
    if (req.headers['x-requested-with'] !== 'nocap') throw new HttpError(403, 'Missing request header.');
  }

  async function startSession(db, req, res, userId, status, body) {
    const token = randHex(32);
    await db.query(`INSERT INTO auth_sessions(token_hash, user_id, expires_at) VALUES ($1, $2, $3::double precision)`, [
      sha256(token),
      userId,
      Date.now() + AUTH_TTL_MS
    ]);
    send(res, status, body, {
      'Set-Cookie': `nocap_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${AUTH_TTL_MS / 1000}${isSecure(req) ? '; Secure' : ''}`
    });
  }

  const policyOf = (row) => (typeof row.policy === 'string' ? JSON.parse(row.policy) : row.policy);
  const publicExam = (e) => ({ id: e.id, title: e.title, formUrl: e.form_url, policy: policyOf(e) });
  const teacherExam = (e) => ({
    id: e.id,
    title: e.title,
    formUrl: e.form_url,
    code: e.code,
    open: e.open,
    policy: policyOf(e),
    createdAt: e.created_at,
    studentCount: Number(e.student_count ?? 0)
  });

  async function ownExam(db, user, id) {
    const rows = await db.query(
      `SELECT e.*, (SELECT COUNT(*)::int FROM students s WHERE s.exam_id = e.id) AS student_count
       FROM exams e WHERE e.id = $1 AND e.user_id = $2`,
      [id, user.id]
    );
    if (!rows[0]) throw new HttpError(404, 'Exam not found.');
    return rows[0];
  }

  /** Students of an exam (changed since `since`), each with their stored sessions, newest first. */
  async function loadStudents(db, examId, since = 0) {
    const students = await db.query(
      `SELECT id, name, student_id, joined_at, consent_at, last_seen_at, updated_at
       FROM students WHERE exam_id = $1 AND updated_at >= $2::double precision ORDER BY joined_at`,
      [examId, since]
    );
    if (!students.length) return [];
    const sessions = await db.query(
      `SELECT student_id, data FROM exam_sessions WHERE student_id = ANY($1::text[]) ORDER BY started_at DESC`,
      [students.map((s) => s.id)]
    );
    const by = new Map();
    for (const s of sessions) {
      const data = typeof s.data === 'string' ? JSON.parse(s.data) : s.data;
      if (!by.has(s.student_id)) by.set(s.student_id, []);
      by.get(s.student_id).push(data);
    }
    return students.map((s) => ({
      id: s.id,
      name: s.name,
      studentId: s.student_id,
      joinedAt: s.joined_at,
      consentAt: s.consent_at,
      lastSeenAt: s.last_seen_at,
      updatedAt: s.updated_at,
      sessions: by.get(s.id) || []
    }));
  }

  async function studentFromToken(db, token) {
    if (typeof token !== 'string' || token.length < 20) throw new HttpError(401, 'This connection is no longer valid. Reconnect from NO CAP settings.');
    const rows = await db.query(
      `SELECT s.id AS student_pk, e.* FROM students s JOIN exams e ON e.id = s.exam_id WHERE s.token_hash = $1`,
      [sha256(token)]
    );
    if (!rows[0]) throw new HttpError(401, 'This connection is no longer valid. Reconnect from NO CAP settings.');
    return rows[0];
  }

  async function newExamCode(db, exam) {
    for (let attempt = 0; attempt < 8; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      const rows = await db.query(
        `INSERT INTO exams(id, user_id, title, form_url, code, open, policy, created_at)
         VALUES ($1, $2, $3, $4, $5, true, $6::jsonb, $7::double precision)
         ON CONFLICT (code) DO NOTHING RETURNING id`,
        [exam.id, exam.userId, exam.title, exam.formUrl, code, JSON.stringify(exam.policy), exam.createdAt]
      );
      if (rows[0]) return code;
    }
    throw new HttpError(500, 'Could not allocate a join code. Try again.');
  }

  // ------------------------------------------------------------ routes

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;
    const ip = clientIp(req);
    const db = await getDb();

    if (p === '/api/config' && m === 'GET') {
      return send(res, 200, { signupCodeRequired: !!signupCode, allowedDomains, retentionDays });
    }

    // ---------- student API (called by the extension, CORS enabled) ----------
    if (['/api/join', '/api/sync', '/api/policy'].includes(p)) {
      if (m === 'OPTIONS') return send(res, 204, '', { ...corsStudent, 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
      if (m !== 'POST') throw new HttpError(405, 'Use POST.');
      const body = await readJson(req);

      if (p === '/api/join') {
        await limit(db, `join:${ip}`, 30, 60_000, 'Too many attempts. Wait a minute and try again.');
        const code = str(body.code, 12).toUpperCase().trim();
        const exams = await db.query(`SELECT * FROM exams WHERE code = $1`, [code]);
        const exam = exams[0];
        if (!exam || !exam.open) throw new HttpError(404, 'Unknown or closed join code.');
        if (body.consent !== true) throw new HttpError(400, 'Student consent is required.');
        const name = str(body.name, 80).trim();
        if (!name) throw new HttpError(400, 'Enter your name.');
        const count = await db.query(`SELECT COUNT(*)::int AS n FROM students WHERE exam_id = $1`, [exam.id]);
        if (count[0].n >= MAX_STUDENTS_PER_EXAM) throw new HttpError(429, 'This exam is full.');

        const token = randHex(24);
        const now = Date.now();
        await db.query(
          `INSERT INTO students(id, exam_id, name, student_id, token_hash, joined_at, consent_at, last_seen_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::double precision, $6::double precision, $6::double precision, $6::double precision)`,
          [randHex(6), exam.id, name, str(body.studentId, 40).trim(), sha256(token), now]
        );
        return send(res, 200, { ok: true, token, exam: publicExam(exam) }, corsStudent);
      }

      const exam = await studentFromToken(db, body.token);

      if (p === '/api/policy') return send(res, 200, { ok: true, exam: publicExam(exam) }, corsStudent);

      // /api/sync
      const snap = sanitizeSnapshot(body.session);
      if (!snap) throw new HttpError(400, 'Invalid session data.');
      const now = Date.now();
      const up = await db.query(
        `INSERT INTO exam_sessions(student_id, session_id, data, started_at) VALUES ($1, $2, $3::jsonb, $4::double precision)
         ON CONFLICT (student_id, session_id) DO UPDATE SET data = EXCLUDED.data
         RETURNING (xmax = 0) AS inserted`,
        [exam.student_pk, snap.id, JSON.stringify(snap), snap.startedAt]
      );
      if (up[0] && up[0].inserted) {
        await db.query(
          `DELETE FROM exam_sessions WHERE student_id = $1 AND session_id NOT IN
             (SELECT session_id FROM exam_sessions WHERE student_id = $1 ORDER BY started_at DESC LIMIT ${MAX_SESSIONS_PER_STUDENT})`,
          [exam.student_pk]
        );
      }
      await db.query(`UPDATE students SET last_seen_at = $2::double precision, updated_at = $2::double precision WHERE id = $1`, [exam.student_pk, now]);
      return send(res, 200, { ok: true }, corsStudent);
    }

    // ---------- scheduled retention purge (Vercel Cron) ----------
    if (p === '/api/cron/purge' && m === 'GET') {
      if (!cronSecret) throw new HttpError(404, 'Not found.');
      const auth = String(req.headers.authorization || '');
      if (!safeEqual(auth, `Bearer ${cronSecret}`)) throw new HttpError(401, 'Unauthorized.');
      const now = Date.now();
      let exams = [];
      if (retentionDays > 0) {
        const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
        exams = await db.query(
          `DELETE FROM exams e
           WHERE GREATEST(e.created_at, COALESCE((SELECT MAX(s.last_seen_at) FROM students s WHERE s.exam_id = e.id), 0)) < $1::double precision
           RETURNING id`,
          [cutoff]
        );
      }
      await db.query(`DELETE FROM auth_sessions WHERE expires_at < $1::double precision`, [now]);
      await db.query(`DELETE FROM rate_limits WHERE reset_at < $1::double precision`, [now]);
      return send(res, 200, { ok: true, examsDeleted: exams.length });
    }

    // ---------- accounts ----------
    if (p === '/api/signup' && m === 'POST') {
      requireXrw(req);
      await limit(db, `signup:${ip}`, 10, 60 * 60_000, 'Too many sign-ups from this network. Try again later.');
      const body = await readJson(req, 8192);
      const name = str(body.name, 80).trim();
      const email = str(body.email, 254).trim().toLowerCase();
      const password = typeof body.password === 'string' ? body.password : '';
      if (!name) throw new HttpError(400, 'Enter your name.');
      if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
      if (password.length < 10) throw new HttpError(400, 'Use a password of at least 10 characters.');
      if (password.length > 200) throw new HttpError(400, 'That password is too long.');
      if (allowedDomains.length && !allowedDomains.includes(email.split('@')[1])) {
        throw new HttpError(403, `Accounts are limited to these email domains: ${allowedDomains.join(', ')}.`);
      }
      if (signupCode && !safeEqual(str(body.code, 200), signupCode)) throw new HttpError(403, 'That invitation code is not correct.');

      const id = randHex(8);
      const created = await db.query(
        `INSERT INTO users(id, email, name, pass_hash, created_at) VALUES ($1, $2, $3, $4, $5::double precision)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [id, email, name, await hashPassword(password), Date.now()]
      );
      if (!created[0]) throw new HttpError(409, 'An account with that email already exists. Sign in instead.');
      return startSession(db, req, res, id, 201, { ok: true, user: { name, email } });
    }

    if (p === '/api/login' && m === 'POST') {
      requireXrw(req);
      const body = await readJson(req, 8192);
      const email = str(body.email, 254).trim().toLowerCase();
      await limit(db, `login:${ip}`, 40, 5 * 60_000);
      await limit(db, `login:${ip}:${email}`, 10, 5 * 60_000);
      const rows = await db.query(`SELECT id, email, name, pass_hash FROM users WHERE email = $1`, [email]);
      const user = rows[0];
      const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
      if (!user) {
        await burnVerify(password);
        throw new HttpError(401, 'Incorrect email or password.');
      }
      if (!(await verifyPassword(password, user.pass_hash))) throw new HttpError(401, 'Incorrect email or password.');
      return startSession(db, req, res, user.id, 200, { ok: true, user: { name: user.name, email: user.email } });
    }

    if (p === '/api/logout' && m === 'POST') {
      requireXrw(req);
      const sid = parseCookies(req).nocap_sid;
      if (sid) await db.query(`DELETE FROM auth_sessions WHERE token_hash = $1`, [sha256(sid)]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'nocap_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }

    if (p === '/api/me' && m === 'GET') {
      const user = await currentUser(db, req);
      return send(res, 200, {
        authed: !!user,
        user: user ? { name: user.name, email: user.email } : null,
        retentionDays,
        signupCodeRequired: !!signupCode,
        allowedDomains
      });
    }

    // ---------- teacher API ----------
    if (p.startsWith('/api/')) {
      const user = await requireTeacher(db, req);

      if (p === '/api/account/delete' && m === 'POST') {
        const body = await readJson(req, 8192);
        const rows = await db.query(`SELECT pass_hash FROM users WHERE id = $1`, [user.id]);
        if (!rows[0] || !(await verifyPassword(typeof body.password === 'string' ? body.password.slice(0, 200) : '', rows[0].pass_hash))) {
          throw new HttpError(401, 'Incorrect password.');
        }
        await db.query(`DELETE FROM users WHERE id = $1`, [user.id]); // cascades to exams, students and reports
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'nocap_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }

      if (p === '/api/exams' && m === 'GET') {
        const rows = await db.query(
          `SELECT e.*, (SELECT COUNT(*)::int FROM students s WHERE s.exam_id = e.id) AS student_count
           FROM exams e WHERE e.user_id = $1 ORDER BY e.created_at DESC`,
          [user.id]
        );
        return send(res, 200, { exams: rows.map(teacherExam), defaults: sanitizePolicy({}) });
      }

      if (p === '/api/exams' && m === 'POST') {
        const body = await readJson(req);
        const count = await db.query(`SELECT COUNT(*)::int AS n FROM exams WHERE user_id = $1`, [user.id]);
        if (count[0].n >= MAX_EXAMS_PER_USER) throw new HttpError(429, 'You have reached the limit of 100 exams. Delete old ones first.');
        const exam = {
          id: randHex(6),
          userId: user.id,
          title: cleanTitle(body.title),
          formUrl: cleanFormUrl(body.formUrl),
          policy: sanitizePolicy(body.policy),
          createdAt: Date.now()
        };
        await newExamCode(db, exam);
        return send(res, 201, { exam: teacherExam({ ...(await ownExam(db, user, exam.id)) }) });
      }

      const em = /^\/api\/exams\/([0-9a-f]+)(\/live|\/export\.csv)?$/.exec(p);
      if (em) {
        const exam = await ownExam(db, user, em[1]);

        if (em[2] === '/live' && m === 'GET') {
          const since = Number(url.searchParams.get('since')) || 0;
          const students = await loadStudents(db, exam.id, since);
          const cursor = students.reduce((max, s) => Math.max(max, s.updatedAt), since);
          return send(res, 200, { students, cursor, now: Date.now() });
        }

        if (em[2] === '/export.csv' && m === 'GET') {
          const header = ['exam', 'student_name', 'student_id', 'session_id', 'incident_number', 'time_iso', 'category', 'evidence', 'domain', 'domain_category', 'details'];
          const lines = [header.map(csvCell).join(',')];
          for (const s of await loadStudents(db, exam.id, 0)) {
            for (const sess of s.sessions) {
              [...sess.incidents].sort((a, b) => a.ts - b.ts).forEach((inc, i) => {
                lines.push([
                  exam.title, s.name, s.studentId, sess.id, i + 1, new Date(inc.ts).toISOString(),
                  CATEGORY_META[inc.category].label, isConfirmed(inc) ? 'Detected' : 'Not confirmed',
                  inc.domain || '', inc.domainCategory || '', inc.details.join(' | ')
                ].map(csvCell).join(','));
              });
            }
          }
          return send(res, 200, lines.join('\r\n'), {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="nocap-${exam.code}.csv"`
          });
        }

        if (!em[2] && m === 'GET') {
          return send(res, 200, { exam: teacherExam(exam), students: await loadStudents(db, exam.id, 0), now: Date.now() });
        }

        if (!em[2] && m === 'PATCH') {
          const body = await readJson(req);
          const title = 'title' in body ? cleanTitle(body.title) : exam.title;
          const formUrl = 'formUrl' in body ? cleanFormUrl(body.formUrl) : exam.form_url;
          const policy = 'policy' in body ? sanitizePolicy(body.policy, policyOf(exam)) : policyOf(exam);
          const open = 'open' in body ? !!body.open : exam.open;
          await db.query(`UPDATE exams SET title = $2, form_url = $3, policy = $4::jsonb, open = $5 WHERE id = $1`, [exam.id, title, formUrl, JSON.stringify(policy), open]);
          return send(res, 200, { exam: teacherExam(await ownExam(db, user, exam.id)) });
        }

        if (!em[2] && m === 'DELETE') {
          await db.query(`DELETE FROM exams WHERE id = $1`, [exam.id]); // cascades to students and reports
          return send(res, 200, { ok: true });
        }
      }
    }

    throw new HttpError(404, 'Not found.');
  }

  return async function handler(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      if (res.headersSent) return res.end();
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('[nocap-dashboard]', err);
      const extra = req.url && /^\/api\/(join|sync|policy)/.test(req.url) ? corsStudent : {};
      send(res, status, { ok: false, error: status === 500 ? 'Server error. Please try again.' : err.message }, extra);
    }
  };
}
