// Run with: node tests/dashboard-integration.mjs   (needs "npm install" once in ./dashboard)
// The REAL extension background.js (mocked chrome.* API) talks to the REAL hosted-dashboard backend over HTTP.
import assert from 'node:assert/strict';
import { createLocalServer } from '../dashboard/local.js';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSeAbCdEfGhIjKlMnOpQrStUvWxYz0123456789/viewform';
const PW = 'a-long-password-123';

let skew = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + skew;

// ---- chrome mock ----
const store = {};
const L = {};
const ev = (name) => ({ addListener: (fn) => { (L[name] ||= []).push(fn); } });
let tabs = [];
globalThis.chrome = {
  runtime: { id: EXT_ID, getURL: (p = '') => `chrome-extension://${EXT_ID}/${p}`, onInstalled: ev('installed'), onStartup: ev('startup'), onMessage: ev('message') },
  storage: { local: {
    async get(keys) { const ks = Array.isArray(keys) ? keys : [keys]; const o = {}; for (const k of ks) if (k in store) o[k] = structuredClone(store[k]); return o; },
    async set(o) { for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); },
    async remove(k) { for (const key of [].concat(k)) delete store[key]; } } },
  permissions: { async contains() { return true; } },
  tabs: { onActivated: ev('activated'), onCreated: ev('created'), onUpdated: ev('updated'), onRemoved: ev('removed'), onReplaced: ev('replaced'),
    async query(q) { return tabs.filter((t) => (q.active == null || t.active === q.active) && (q.windowId == null || t.windowId === q.windowId)); },
    async get(id) { const t = tabs.find((x) => x.id === id); if (!t) throw new Error('no tab'); return t; },
    async update() {}, async remove() {}, async create() {}, async goBack() {} },
  windows: { WINDOW_ID_NONE: -1, onFocusChanged: ev('focus'), async getLastFocused() { return { id: 1 }; }, async update() {} },
  alarms: { onAlarm: ev('alarm'), async create() {}, async clear() {} },
  notifications: { onClicked: ev('notifClick'), async create() {} },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
};
await import('../background.js');

const extSender = { id: EXT_ID, url: chrome.runtime.getURL('options.html') };
const msg = (m, sender = extSender) => new Promise((resolve) => L.message[0](m, sender, resolve));
const fire = (name, ...args) => { for (const fn of L[name]) fn(...args); };
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

// ---- hosted dashboard backend ----
const app = await createLocalServer({ localDir: ':memory:', env: {} });
const addr = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${addr.port}`;
const api = async (method, p, body, cookie) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nocap', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
};
const signup = await api('POST', '/api/signup', { name: 'Prof Dela Cruz', email: 'prof@school.edu', password: PW });
const cookie = signup.headers.get('set-cookie').split(';')[0];
const created = await api('POST', '/api/exams', { title: 'Chem quiz', formUrl: FORM, policy: { violationThreshold: 1, graceSeconds: 5 } }, cookie);
const exam = created.json.exam;
const roster = async () => (await api('GET', `/api/exams/${exam.id}`, undefined, cookie)).json.students;

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ' + name); };

tabs = [
  { id: 1, windowId: 1, url: FORM, active: true },
  { id: 2, windowId: 1, url: 'https://chatgpt.com/c/private-chat-id?q=secret', active: false }
];

await t('connect: needs consent, a valid address and a real join code', async () => {
  const b = { server: base, code: exam.code, name: 'Ben Cruz', studentId: 'S-9' };
  assert.equal((await msg({ type: 'connect', ...b, consent: false })).ok, false);
  assert.equal((await msg({ type: 'connect', ...b, server: 'http://evil.example.com', consent: true })).ok, false);
  assert.equal((await msg({ type: 'connect', ...b, code: 'ZZZZZZ', consent: true })).ok, false);
  assert.equal(store.connection, undefined, 'nothing stored after failed attempts');
});

await t('connect succeeds; the instructor’s form and rules replace local settings', async () => {
  const r = await msg({ type: 'connect', server: base, code: exam.code, name: 'Ben Cruz', studentId: 'S-9', consent: true });
  assert.ok(r.ok, r.error);
  assert.equal(store.connection.examTitle, 'Chem quiz');
  assert.equal(store.settings.examUrl, FORM);
  assert.equal(store.settings.violationThreshold, 1);
  assert.equal(store.settings.graceSeconds, 5);
  assert.equal((await roster()).length, 1);
});

await t('web pages cannot call connect/disconnect', async () => {
  const web = { id: EXT_ID, url: FORM, tab: { id: 1 } };
  assert.equal((await msg({ type: 'disconnect' }, web)).ok, false);
  assert.equal((await msg({ type: 'connect', server: base, code: exam.code, name: 'x', consent: true }, web)).ok, false);
});

await t('start exam reports the session and applies the instructor’s rules', async () => {
  const r = await msg({ type: 'startExam', rulesAccepted: true });
  assert.ok(r.ok, r.error);
  assert.equal(store.session.config.violationThreshold, 1);
  assert.ok(store.session.events.some((e) => e.type === 'policy' && /supplied the exam rules/.test(e.detail)));
  await settle();
  const s = (await roster())[0];
  assert.equal(s.sessions[0].status, 'in_progress');
  assert.equal(s.sessions[0].id, store.session.id);
});

await t('the instructor edits the rules; the next session picks them up', async () => {
  await api('PATCH', `/api/exams/${exam.id}`, { policy: { violationThreshold: 4, graceSeconds: 5, strictMode: false } }, cookie);
  await msg({ type: 'endExam' });
  await settle();
  assert.equal((await roster())[0].sessions[0].status, 'ended');
  const r = await msg({ type: 'startExam', rulesAccepted: true });
  assert.ok(r.ok, r.error);
  assert.equal(store.session.config.violationThreshold, 4);
});

await t('an incident reaches the dashboard: domain only, no URL path/query, no tab ids, no local config', async () => {
  tabs[0].active = false; tabs[1].active = true;
  fire('activated', { tabId: 2, windowId: 1 });
  fire('updated', 2, { url: tabs[1].url }, tabs[1]);
  await settle(500);
  const live = (await roster())[0].sessions.find((x) => x.id === store.session.id);
  assert.equal(live.status, 'violation');
  assert.equal(live.incidents.length, 1);
  assert.equal(live.incidents[0].category, 'prohibited_site');
  assert.equal(live.incidents[0].domain, 'chatgpt.com');
  const raw = JSON.stringify(live);
  assert.ok(!raw.includes('private-chat-id') && !raw.includes('secret'), 'no path or query leaves the device');
  assert.ok(!('tabId' in live.incidents[0]) && !('config' in live));
  assert.ok(store.connection.lastSyncAt, 'connection records the last successful report');
});

await t('the dashboard poll sees the new incident (cursor-based)', async () => {
  const first = await api('GET', `/api/exams/${exam.id}/live?since=0`, undefined, cookie);
  const quiet = await api('GET', `/api/exams/${exam.id}/live?since=${first.json.cursor + 1}`, undefined, cookie);
  assert.equal(quiet.json.students.length, 0);
  await msg({ type: 'returnToExam' });
  await settle(500);
  const after = await api('GET', `/api/exams/${exam.id}/live?since=${first.json.cursor + 1}`, undefined, cookie);
  assert.equal(after.json.students.length, 1);
  assert.equal(after.json.students[0].sessions[0].status, 'in_progress', 'acknowledgement is reflected');
  assert.ok(after.json.students[0].sessions[0].incidents[0].ackTs);
});

await t('another instructor cannot see this student', async () => {
  const other = await api('POST', '/api/signup', { name: 'Other', email: 'other@school.edu', password: PW });
  const oc = other.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('GET', `/api/exams/${exam.id}/live?since=0`, undefined, oc)).status, 404);
});

await t('dashboard outage: monitoring continues locally and the failure is shown to the student', async () => {
  await app.close();
  skew += 60000;
  tabs[0].active = true; tabs[1].active = false;
  fire('created', { id: 3, windowId: 1, pendingUrl: 'chrome://newtab/', active: true });
  await settle(400);
  assert.equal(store.session.incidents.length, 2, 'incident still recorded locally');
  assert.match(store.connection.lastError || '', /could not be reached/);
});

await t('disconnect stops reporting but keeps local logs', async () => {
  await msg({ type: 'endExam' });
  const total = store.session.incidents.length;
  assert.ok((await msg({ type: 'disconnect' })).ok);
  assert.equal(store.connection, undefined);
  assert.equal(store.session.incidents.length, total);
});

console.log(`\n${n} integration scenarios passed`);
process.exit(0);
