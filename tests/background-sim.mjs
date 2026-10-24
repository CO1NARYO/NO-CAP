// Run with: node tests/background-sim.mjs
// Drives background.js with a mocked chrome.* API to check detection, merging and lifecycle logic.
// This does NOT replace the manual tests in detection-tests.md (real Chrome behaviour differs).
import assert from 'node:assert/strict';

// ---- controllable clock ----
let skew = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + skew;

// ---- minimal chrome mock ----
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const store = {};
const L = {}; // captured listeners
const ev = (name) => ({ addListener: (fn) => { (L[name] ||= []).push(fn); } });
let tabs = [];
const notifications = [];
const calls = [];

globalThis.chrome = {
  runtime: { id: EXT_ID, getURL: (p = '') => `chrome-extension://${EXT_ID}/${p}`, onInstalled: ev('installed'), onStartup: ev('startup'), onMessage: ev('message') },
  storage: {
    local: {
      async get(keys) { const ks = Array.isArray(keys) ? keys : [keys]; const o = {}; for (const k of ks) if (k in store) o[k] = structuredClone(store[k]); return o; },
      async set(o) { for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); },
      async remove(k) { for (const key of [].concat(k)) delete store[key]; }
    }
  },
  tabs: {
    onActivated: ev('activated'), onCreated: ev('created'), onUpdated: ev('updated'), onRemoved: ev('removed'), onReplaced: ev('replaced'),
    async query(q) { return tabs.filter((t) => (q.active == null || t.active === q.active) && (q.windowId == null || t.windowId === q.windowId)); },
    async get(id) { const t = tabs.find((x) => x.id === id); if (!t) throw new Error('no tab'); return t; },
    async update(id, p) { calls.push(['tabs.update', id, p]); },
    async remove(id) { calls.push(['tabs.remove', id]); },
    async create(p) { calls.push(['tabs.create', p]); },
    async goBack(id) { calls.push(['tabs.goBack', id]); }
  },
  windows: { WINDOW_ID_NONE: -1, onFocusChanged: ev('focus'), async getLastFocused() { return { id: 1 }; }, async update(id, p) { calls.push(['windows.update', id, p]); } },
  alarms: { onAlarm: ev('alarm'), async create() {}, async clear() {} },
  notifications: { onClicked: ev('notifClick'), async create(id, o) { notifications.push(o); } },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
};

await import('../background.js');

const FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSeAbCdEfGhIjKlMnOpQrStUvWxYz0123456789/viewform';
const extSender = { id: EXT_ID, url: chrome.runtime.getURL('popup.html') };
const msg = (m, sender = extSender) => new Promise((resolve) => L.message[0](m, sender, resolve));
const fire = (name, ...args) => { for (const fn of L[name]) fn(...args); };
const settle = () => new Promise((r) => setTimeout(r, 30));
const session = () => store.session;
const examSender = () => ({ id: EXT_ID, url: FORM, tab: { id: 1 } });
let n = 0;
const t = async (name, fn) => { await fn(); await settle(); n++; console.log('ok  ' + name); };

tabs = [
  { id: 1, windowId: 1, url: FORM, active: true },
  { id: 2, windowId: 1, url: 'https://chatgpt.com/c/abc?x=1', active: false }
];

await t('start is refused without accepting rules or a saved link', async () => {
  assert.equal((await msg({ type: 'startExam', rulesAccepted: false })).ok, false);
  assert.equal((await msg({ type: 'startExam', rulesAccepted: true })).ok, false);
});
await t('saving an invalid link fails; a valid link is canonicalised', async () => {
  assert.equal((await msg({ type: 'saveSettings', settings: { examUrl: 'https://example.com' } })).ok, false);
  const r = await msg({ type: 'saveSettings', settings: { examUrl: FORM + '?usp=sf_link' } });
  assert.ok(r.ok); assert.equal(r.settings.examUrl, FORM);
});
await t('privileged messages from a web page context are denied', async () => {
  const web = { id: EXT_ID, url: FORM, tab: { id: 1 } };
  assert.equal((await msg({ type: 'startExam', rulesAccepted: true }, web)).ok, false);
  assert.equal((await msg({ type: 'saveSettings', settings: { strictMode: true } }, web)).ok, false);
  assert.equal((await msg({ type: 'resetData' }, web)).ok, false);
});
await t('start works from the active exam tab and freezes settings', async () => {
  const r = await msg({ type: 'startExam', rulesAccepted: true });
  assert.ok(r.ok, r.error);
  assert.equal(session().status, 'in_progress');
  assert.equal(session().examTabId, 1);
  assert.equal((await msg({ type: 'saveSettings', settings: { strictMode: true } })).ok, false);
});
await t('switching to ChatGPT = ONE incident, upgraded to prohibited_site, merged signals', async () => {
  tabs[0].active = false; tabs[1].active = true;
  fire('activated', { tabId: 2, windowId: 1 });
  fire('updated', 2, { url: tabs[1].url }, tabs[1]);
  await msg({ type: 'visibility', state: 'hidden', ts: Date.now() }, examSender());
  await settle();
  const s = session();
  assert.equal(s.incidents.length, 1);
  const inc = s.incidents[0];
  assert.equal(inc.category, 'prohibited_site');
  assert.equal(inc.domain, 'chatgpt.com');
  assert.equal(inc.domainCategory, 'AI assistant');
  const types = inc.signals.map((x) => x.type);
  for (const x of ['tab_switch', 'prohibited_site', 'visibility_hidden']) assert.ok(types.includes(x), x);
  assert.equal(s.status, 'violation');
  assert.ok(!JSON.stringify(s).includes('abc?x=1'), 'query/path must not be stored');
  assert.equal(notifications.length, 2, 'notified on creation and on upgrade only');
});
await t('returning to the exam keeps the incident and clears the warning state', async () => {
  tabs[0].active = true; tabs[1].active = false;
  await msg({ type: 'visibility', state: 'visible', ts: Date.now() }, examSender());
  const r = await msg({ type: 'returnToExam' });
  assert.ok(r.ok);
  assert.equal(session().incidents.length, 1);
  assert.ok(session().incidents[0].ackTs);
  assert.equal(session().status, 'in_progress');
  assert.ok(session().incidents[0].signals.find((x) => x.type === 'visibility_hidden').endedTs);
});
await t('focus loss shorter than the grace period is ignored', async () => {
  skew += 60000;
  fire('focus', -1); await settle();
  skew += 1000;
  fire('focus', 1); await settle();
  assert.equal(session().incidents.length, 1);
  assert.equal(session().ignoredFocusBlips, 1);
});
await t('focus loss longer than the grace period = one UNCONFIRMED incident', async () => {
  skew += 60000;
  fire('focus', -1); await settle();
  skew += 10000;
  fire('focus', 1); await settle();
  const s = session();
  assert.equal(s.incidents.length, 2);
  const inc = s.incidents[1];
  assert.equal(inc.category, 'window_focus_lost');
  assert.deepEqual(inc.signals.map((x) => x.type), ['window_focus_lost']);
  assert.match(inc.details[0], /cannot be determined/);
});
await t('minimizing (hidden + focus lost together) is counted once', async () => {
  skew += 60000;
  fire('focus', -1);
  await msg({ type: 'visibility', state: 'hidden', ts: Date.now() }, examSender());
  skew += 8000;
  fire('focus', 1);
  await msg({ type: 'visibility', state: 'visible', ts: Date.now() }, examSender());
  await settle();
  assert.equal(session().incidents.length, 3);
  const types = session().incidents[2].signals.map((x) => x.type);
  assert.ok(types.includes('window_focus_lost') && types.includes('visibility_hidden'));
});
await t('threshold reached => session flagged for review (not a verdict)', async () => {
  assert.equal(session().flagged, true);
  assert.ok(session().events.some((e) => e.type === 'flagged' && /not a finding of misconduct/.test(e.detail)));
});
await t('new tab = ONE incident (new_tab) even though activation also fires', async () => {
  skew += 60000;
  tabs.push({ id: 3, windowId: 1, url: '', pendingUrl: 'chrome://newtab/', active: true });
  tabs[0].active = false;
  fire('created', tabs[2]);
  fire('activated', { tabId: 3, windowId: 1 });
  await settle();
  assert.equal(session().incidents.length, 4);
  assert.equal(session().incidents[3].category, 'new_tab');
  assert.equal(calls.filter((c) => c[0] === 'tabs.remove').length, 0, 'strict mode off: nothing is closed');
});
await t('navigating the exam tab to another site is recorded', async () => {
  skew += 60000;
  tabs[0].active = true; tabs[2].active = false;
  tabs[0].url = 'https://en.wikipedia.org/wiki/Cat';
  fire('updated', 1, { url: tabs[0].url }, tabs[0]);
  await settle();
  const inc = session().incidents[4];
  assert.equal(inc.category, 'unauthorized_url'); assert.equal(inc.domain, 'en.wikipedia.org');
  tabs[0].url = FORM;
  fire('updated', 1, { url: FORM }, tabs[0]); await settle();
  assert.equal(session().incidents.length, 5, 'coming back to the form is not an incident');
});
await t('closing the exam tab is recorded; reopening the form re-attaches monitoring', async () => {
  skew += 60000;
  const closed = tabs.shift();
  fire('removed', 1, { isWindowClosing: false }); await settle();
  assert.equal(session().incidents[5].category, 'exam_tab_closed');
  assert.equal(session().examTabId, null);
  skew += 60000;
  const back = { id: 9, windowId: 1, url: FORM, active: true };
  tabs.push(back);
  fire('updated', 9, { url: FORM }, back); await settle();
  assert.equal(session().examTabId, 9);
  assert.equal(session().incidents.length, 6);
});
await t('interrupted session (browser restart) logs an interruption and keeps incidents', async () => {
  const before = session().incidents.length;
  skew += 120000;
  for (const fn of L.startup) fn();
  await settle();
  assert.equal(session().interruptions, 1);
  assert.equal(session().incidents.length, before);
  assert.equal(session().examTabId, 9, 'exam tab found again by URL');
  // events right after restart are ignored (quiet period) so startup noise is not logged
  fire('created', { id: 50, windowId: 1, pendingUrl: 'chrome://newtab/' }); await settle();
  assert.equal(session().incidents.length, before);
  skew += 20000;
});
await t('ending the exam preserves the log; data is deleted only on request', async () => {
  const total = session().incidents.length;
  assert.ok((await msg({ type: 'endExam' })).ok);
  assert.equal(session().status, 'ended');
  assert.equal(session().incidents.length, total);
  // events after the end are ignored
  fire('created', { id: 60, windowId: 1, pendingUrl: 'https://x.com' }); await settle();
  assert.equal(session().incidents.length, total);
  // starting a new session archives the old one instead of deleting it
  tabs.forEach((x) => (x.active = x.id === 9));
  assert.ok((await msg({ type: 'startExam', rulesAccepted: true })).ok);
  assert.equal(store.archive.length, 1);
  assert.equal(store.archive[0].incidents.length, total);
  // reset refused while running, allowed after ending
  assert.equal((await msg({ type: 'resetData', what: 'logs' })).ok, false);
  await msg({ type: 'endExam' });
  assert.ok((await msg({ type: 'resetData', what: 'logs' })).ok);
  await settle();
  assert.equal(store.session, undefined); assert.equal(store.archive, undefined);
});

console.log(`\n${n} simulated scenarios passed`);
process.exit(0);
