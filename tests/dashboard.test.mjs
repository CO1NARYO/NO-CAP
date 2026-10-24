// Run with: node tests/dashboard.test.mjs   (needs "npm install" once in ./dashboard)
// Runs the real hosted-dashboard backend against a real Postgres engine (PGlite) over real HTTP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalServer } from '../dashboard/local.js';
import { createHandler } from '../dashboard/lib/app.js';
import { sanitizeSnapshot } from '../dashboard/lib/sanitize.js';
import { hashPassword, verifyPassword } from '../dashboard/lib/auth.js';

const FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSeAbCdEfGhIjKlMnOpQrStUvWxYz0123456789/viewform';
const PW = 'a-long-password-123';
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ' + name); };

async function start(env = {}, localDir = ':memory:') {
  const app = await createLocalServer({ localDir, env });
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (method, p, body, { cookie, headers = {}, xrw = true } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(xrw ? { 'X-Requested-With': 'nocap' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const signup = async (email, over = {}) => {
    const r = await call('POST', '/api/signup', { name: 'Prof ' + email.split('@')[0], email, password: PW, ...over });
    return { ...r, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  return { app, base, call, signup };
}

const snapshot = (over = {}) => ({
  id: 'NC-20261019-A1B2C3', status: 'violation', startedAt: Date.now() - 60000, endedAt: null,
  lastHeartbeat: Date.now(), flagged: false, flaggedAt: null, threshold: 3, interruptions: 0, ignoredFocusBlips: 0,
  formResponseSeen: false,
  incidents: [{ id: 'NC-20261019-A1B2C3-001', ts: Date.now() - 5000, category: 'prohibited_site', warning: 'w',
    domain: 'chatgpt.com', domainCategory: 'AI assistant', details: ['Switched to chatgpt.com.'],
    signals: [{ type: 'tab_switch', ts: Date.now() - 5000 }], ackTs: null }],
  events: [{ ts: Date.now() - 60000, type: 'started', detail: 'Started' }],
  ...over
});

const S = await start({ CRON_SECRET: 'cron-secret-value', RETENTION_DAYS: '30' });
const { call, signup, base } = S;
let alice, bob, exam, token;

await t('password hashing: verifies right password, rejects wrong, never stores plaintext', async () => {
  const h = await hashPassword(PW);
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(!h.includes(PW));
  assert.equal(await verifyPassword(PW, h), true);
  assert.equal(await verifyPassword('wrong-password-1', h), false);
  assert.equal(await verifyPassword(PW, 'garbage'), false);
});

await t('static page and headers; API is closed to anonymous users', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal((await call('GET', '/api/exams')).status, 401);
  const me = await call('GET', '/api/me');
  assert.equal(me.json.authed, false);
});

await t('signup validates name, email and password strength', async () => {
  assert.equal((await signup('x@school.edu', { name: ' ' })).status, 400);
  assert.equal((await signup('not-an-email')).status, 400);
  assert.equal((await signup('x@school.edu', { password: 'short' })).status, 400);
});

await t('signup creates an account, signs in with an HttpOnly SameSite=Strict cookie, and rejects duplicates', async () => {
  alice = await signup('alice@school.edu');
  assert.equal(alice.status, 201);
  const sc = alice.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  assert.equal((await call('GET', '/api/me', undefined, { cookie: alice.cookie })).json.user.email, 'alice@school.edu');
  assert.equal((await signup('ALICE@school.edu')).status, 409, 'email match is case-insensitive');
});

await t('login: wrong password and unknown email give the same message; right password works; logout ends the session', async () => {
  const bad = await call('POST', '/api/login', { email: 'alice@school.edu', password: 'wrong-password-1' });
  const unknown = await call('POST', '/api/login', { email: 'nobody@school.edu', password: 'wrong-password-1' });
  assert.equal(bad.status, 401); assert.equal(unknown.status, 401);
  assert.equal(bad.json.error, unknown.json.error);
  const ok = await call('POST', '/api/login', { email: 'Alice@School.edu', password: PW });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('POST', '/api/logout', {}, { cookie })).status, 200);
  assert.equal((await call('GET', '/api/exams', undefined, { cookie })).status, 401, 'old cookie is dead');
});

await t('login brute force is rate limited across requests', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await call('POST', '/api/login', { email: 'alice@school.edu', password: 'wrong-password-1' });
  assert.equal(last.status, 429);
});

await t('create exam: validation and join code', async () => {
  assert.equal((await call('POST', '/api/exams', { title: '' }, { cookie: alice.cookie })).status, 400);
  assert.equal((await call('POST', '/api/exams', { title: 'x', formUrl: 'https://example.com' }, { cookie: alice.cookie })).status, 400);
  assert.equal((await call('POST', '/api/exams', { title: 'x', policy: { prohibited: [{ domain: 'bad domain' }] } }, { cookie: alice.cookie })).status, 400);
  const r = await call('POST', '/api/exams', { title: 'Biology midterm', formUrl: FORM + '?usp=sf_link', policy: { violationThreshold: 2, strictMode: true } }, { cookie: alice.cookie });
  assert.equal(r.status, 201);
  exam = r.json.exam;
  assert.match(exam.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(exam.formUrl, FORM);
  assert.equal(exam.policy.violationThreshold, 2);
  assert.ok(exam.policy.prohibited.some((p) => p.domain === 'chatgpt.com'));
});

await t('CSRF: missing header and foreign Origin are rejected on signed-in writes', async () => {
  assert.equal((await call('POST', '/api/exams', { title: 'x' }, { cookie: alice.cookie, xrw: false })).status, 403);
  assert.equal((await call('POST', '/api/exams', { title: 'x' }, { cookie: alice.cookie, headers: { Origin: 'https://evil.example' } })).status, 403);
});

await t('join: unknown code, no consent, no name rejected; success returns token + policy with CORS', async () => {
  assert.equal((await call('POST', '/api/join', { code: 'ZZZZZZ', name: 'A', consent: true })).status, 404);
  assert.equal((await call('POST', '/api/join', { code: exam.code, name: 'Ana', consent: false })).status, 400);
  assert.equal((await call('POST', '/api/join', { code: exam.code, name: ' ', consent: true })).status, 400);
  const r = await call('POST', '/api/join', { code: exam.code.toLowerCase(), name: 'Ana Reyes', studentId: '2024-001', consent: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  token = r.json.token;
  assert.equal(r.json.exam.formUrl, FORM);
  assert.equal(r.json.exam.policy.strictMode, true);
  assert.equal(r.json.exam.code, undefined, 'join code is not echoed to students');
  assert.equal((await fetch(base + '/api/sync', { method: 'OPTIONS' })).status, 204);
});

await t('sync: bad token 401, malformed snapshot 400, valid snapshot accepted', async () => {
  assert.equal((await call('POST', '/api/sync', { token: 'bad', session: snapshot() })).status, 401);
  assert.equal((await call('POST', '/api/sync', { token, session: { id: 'x' } })).status, 400);
  assert.equal((await call('POST', '/api/sync', { token, session: snapshot({ status: 'hacked' }) })).status, 400);
  assert.equal((await call('POST', '/api/sync', { token, session: snapshot() })).status, 200);
});

await t('sanitizer truncates, drops unknown categories, fields and tab ids', () => {
  const dirty = snapshot();
  dirty.secret = 'x';
  dirty.incidents.push({ ts: 1, category: 'made_up' });
  dirty.incidents[0].domain = 'd'.repeat(500);
  dirty.incidents[0].tabId = 77;
  dirty.incidents[0].details = Array.from({ length: 50 }, () => 'z'.repeat(1000));
  const clean = sanitizeSnapshot(dirty);
  assert.equal(clean.secret, undefined);
  assert.equal(clean.incidents.length, 1);
  assert.equal(clean.incidents[0].domain.length, 120);
  assert.equal(clean.incidents[0].tabId, undefined);
  assert.equal(clean.incidents[0].details.length, 10);
  assert.equal(clean.incidents[0].details[0].length, 300);
});

await t('live polling: only students changed since the cursor are returned', async () => {
  const first = await call('GET', `/api/exams/${exam.id}/live?since=0`, undefined, { cookie: alice.cookie });
  assert.equal(first.status, 200);
  assert.equal(first.json.students.length, 1);
  assert.equal(first.json.students[0].name, 'Ana Reyes');
  assert.equal(first.json.students[0].sessions[0].incidents[0].domain, 'chatgpt.com');
  const cursor = first.json.cursor;
  const quiet = await call('GET', `/api/exams/${exam.id}/live?since=${cursor + 1}`, undefined, { cookie: alice.cookie });
  assert.equal(quiet.json.students.length, 0, 'nothing new yet');
  await new Promise((r) => setTimeout(r, 5));
  const second = await call('POST', '/api/join', { code: exam.code, name: 'Ben Cruz', consent: true });
  assert.equal(second.status, 200);
  const next = await call('GET', `/api/exams/${exam.id}/live?since=${cursor + 1}`, undefined, { cookie: alice.cookie });
  assert.deepEqual(next.json.students.map((s) => s.name), ['Ben Cruz']);
  // a later report from Ana is picked up too
  await new Promise((r) => setTimeout(r, 5));
  await call('POST', '/api/sync', { token, session: snapshot({ status: 'ended', endedAt: Date.now() }) });
  const again = await call('GET', `/api/exams/${exam.id}/live?since=${next.json.cursor + 1}`, undefined, { cookie: alice.cookie });
  assert.equal(again.json.students[0].name, 'Ana Reyes');
  assert.equal(again.json.students[0].sessions[0].status, 'ended');
});

await t('exam view never exposes student tokens', async () => {
  const r = await call('GET', `/api/exams/${exam.id}`, undefined, { cookie: alice.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.students.length, 2);
  assert.ok(!r.text.includes(token));
  assert.ok(!/token_hash|tokenHash/.test(r.text));
});

await t('instructors are isolated: another account cannot read, edit, export or delete your exam', async () => {
  bob = await signup('bob@school.edu');
  assert.equal(bob.status, 201);
  assert.deepEqual((await call('GET', '/api/exams', undefined, { cookie: bob.cookie })).json.exams, []);
  for (const [m, p, b] of [['GET', `/api/exams/${exam.id}`], ['GET', `/api/exams/${exam.id}/live`], ['GET', `/api/exams/${exam.id}/export.csv`], ['PATCH', `/api/exams/${exam.id}`, { title: 'hijack' }], ['DELETE', `/api/exams/${exam.id}`]]) {
    assert.equal((await call(m, p, b, { cookie: bob.cookie })).status, 404, `${m} ${p}`);
  }
  assert.equal((await call('GET', `/api/exams/${exam.id}`, undefined, { cookie: alice.cookie })).json.exam.title, 'Biology midterm');
});

await t('CSV export lists incidents and neutralises formulas in student-supplied text', async () => {
  const evil = await call('POST', '/api/join', { code: exam.code, name: '=HYPERLINK("http://x")', consent: true });
  const snap = snapshot({ id: 'NC-20261019-D4E5F6' });
  snap.incidents[0].domain = '=cmd.example.com';
  assert.equal((await call('POST', '/api/sync', { token: evil.json.token, session: snap })).status, 200);
  const r = await call('GET', `/api/exams/${exam.id}/export.csv`, undefined, { cookie: alice.cookie });
  assert.equal(r.status, 200);
  assert.match(r.text, /Biology midterm/);
  assert.match(r.text, /Prohibited website/);
  assert.ok(r.text.includes('"\'=HYPERLINK('));
  assert.ok(r.text.includes('"\'=cmd.example.com"'));
});

await t('only the newest 5 sessions per student are kept', async () => {
  const j = await call('POST', '/api/join', { code: exam.code, name: 'Many Sessions', consent: true });
  for (let i = 0; i < 7; i++) {
    const id = `NC-20261019-00000${i}`;
    await call('POST', '/api/sync', { token: j.json.token, session: snapshot({ id, startedAt: 1000 + i }) });
  }
  const r = await call('GET', `/api/exams/${exam.id}`, undefined, { cookie: alice.cookie });
  const s = r.json.students.find((x) => x.name === 'Many Sessions');
  assert.equal(s.sessions.length, 5);
  assert.equal(s.sessions[0].id, 'NC-20261019-000006');
});

await t('policy endpoint reflects teacher edits; closing joins blocks new students', async () => {
  assert.equal((await call('PATCH', `/api/exams/${exam.id}`, { policy: { violationThreshold: 5 } }, { cookie: alice.cookie })).status, 200);
  const pol = await call('POST', '/api/policy', { token });
  assert.equal(pol.json.exam.policy.violationThreshold, 5);
  assert.equal(pol.json.exam.policy.strictMode, true, 'unspecified fields keep their value');
  assert.equal((await call('PATCH', `/api/exams/${exam.id}`, { open: false }, { cookie: alice.cookie })).status, 200);
  assert.equal((await call('POST', '/api/join', { code: exam.code, name: 'Late', consent: true })).status, 404);
  assert.equal((await call('PATCH', `/api/exams/${exam.id}`, { formUrl: 'https://forms.gle/x' }, { cookie: alice.cookie })).status, 400);
});

await t('Vercel-style request: a body already parsed into req.body is honoured', async () => {
  const handler = createHandler({ getDb: async () => S.app.db, env: {} });
  const hdrs = {};
  let status; let out = '';
  const res = { headersSent: false, writeHead(s, h) { status = s; Object.assign(hdrs, h); this.headersSent = true; }, end(b) { out = b; } };
  const req = { method: 'POST', url: '/api/policy', headers: { 'content-type': 'application/json' }, body: { token }, socket: {} };
  await handler(req, res);
  assert.equal(status, 200);
  assert.equal(JSON.parse(out).exam.title, 'Biology midterm');
});

await t('cron purge: rejects callers without the secret and deletes only inactive exams', async () => {
  assert.equal((await call('GET', '/api/cron/purge')).status, 401);
  assert.equal((await call('GET', '/api/cron/purge', undefined, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const old = (await call('POST', '/api/exams', { title: 'Old exam' }, { cookie: alice.cookie })).json.exam;
  const young = (await call('POST', '/api/exams', { title: 'Young exam' }, { cookie: alice.cookie })).json.exam;
  await S.app.db.query(`UPDATE exams SET created_at = $2::double precision WHERE id = $1`, [old.id, Date.now() - 40 * 24 * 3600 * 1000]);
  const r = await call('GET', '/api/cron/purge', undefined, { headers: { Authorization: 'Bearer cron-secret-value' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.examsDeleted, 1);
  assert.equal((await call('GET', `/api/exams/${old.id}`, undefined, { cookie: alice.cookie })).status, 404);
  assert.equal((await call('GET', `/api/exams/${young.id}`, undefined, { cookie: alice.cookie })).status, 200);
  assert.equal((await call('GET', `/api/exams/${exam.id}`, undefined, { cookie: alice.cookie })).status, 200, 'exam with recent student activity is kept');
});

await t('delete exam removes its students and invalidates their tokens', async () => {
  assert.equal((await call('DELETE', `/api/exams/${exam.id}`, undefined, { cookie: alice.cookie })).status, 200);
  assert.equal((await call('POST', '/api/sync', { token, session: snapshot() })).status, 401);
  const left = await S.app.db.query(`SELECT COUNT(*)::int AS n FROM exam_sessions`);
  assert.equal(left[0].n, 0);
});

await t('account deletion needs the password and erases everything the instructor owns', async () => {
  const e = (await call('POST', '/api/exams', { title: 'Bob exam' }, { cookie: bob.cookie })).json.exam;
  const j = await call('POST', '/api/join', { code: e.code, name: 'Student', consent: true });
  assert.equal((await call('POST', '/api/account/delete', { password: 'wrong-password-1' }, { cookie: bob.cookie })).status, 401);
  assert.equal((await call('POST', '/api/account/delete', { password: PW }, { cookie: bob.cookie })).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, { cookie: bob.cookie })).json.authed, false);
  assert.equal((await call('POST', '/api/sync', { token: j.json.token, session: snapshot() })).status, 401);
  assert.equal((await S.app.db.query(`SELECT COUNT(*)::int AS n FROM users WHERE email = 'bob@school.edu'`))[0].n, 0);
  assert.equal((await call('POST', '/api/login', { email: 'bob@school.edu', password: PW })).status, 401);
});

await S.app.close();

await t('signup can be restricted by email domain and invitation code; cron endpoint is off without CRON_SECRET', async () => {
  const R = await start({ ALLOWED_EMAIL_DOMAINS: 'school.edu, @uni.edu', INSTRUCTOR_SIGNUP_CODE: 'let-me-in' });
  const cfg = (await R.call('GET', '/api/config')).json;
  assert.equal(cfg.signupCodeRequired, true);
  assert.deepEqual(cfg.allowedDomains, ['school.edu', 'uni.edu']);
  assert.equal((await R.signup('a@gmail.com', { code: 'let-me-in' })).status, 403, 'domain');
  assert.equal((await R.signup('a@school.edu', { code: 'wrong' })).status, 403, 'code');
  assert.equal((await R.signup('a@school.edu')).status, 403, 'missing code');
  assert.equal((await R.signup('a@uni.edu', { code: 'let-me-in' })).status, 201);
  assert.equal((await R.call('GET', '/api/cron/purge', undefined, { headers: { Authorization: 'Bearer anything' } })).status, 404, 'purge endpoint does not exist when CRON_SECRET is unset');
  await R.app.close();
});

await t('data persists across a restart when a local folder is used', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nocap-pg-'));
  let R = await start({}, dir);
  const a = await R.signup('persist@school.edu');
  await R.call('POST', '/api/exams', { title: 'Persisted' }, { cookie: a.cookie });
  await R.app.close();
  R = await start({}, dir);
  const login = await R.call('POST', '/api/login', { email: 'persist@school.edu', password: PW });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await R.call('GET', '/api/exams', undefined, { cookie })).json.exams[0].title, 'Persisted');
  await R.app.close();
});

console.log(`\n${n} dashboard checks passed`);
process.exit(0);
