// background.js — NO CAP service worker (Manifest V3, ES module)
//
// Responsibilities
//  * Own the exam session (start / end / acknowledge / return to exam).
//  * Listen to tab, window and visibility signals and turn them into incidents.
//  * Merge signals that describe the same real-world action so nothing is counted twice.
//  * Persist everything in chrome.storage.local (nothing leaves the device).
//
// MV3 service workers can be stopped at any time, so no state lives only in memory:
// every handler reads the session from storage, changes it, and writes it back through
// a single serialized queue (mutate) so concurrent events cannot overwrite each other.

import {
  DEFAULT_SETTINGS,
  MERGE_MS,
  CATEGORY_META,
  parseFormUrl,
  isFormMatch,
  classifyUrl,
  normalizeDomain,
  validateServerUrl,
  formatDuration
} from './shared.js';

const SETTINGS_KEY = 'settings';
const SESSION_KEY = 'session';
const ARCHIVE_KEY = 'archive';
const CONNECTION_KEY = 'connection';
const HEARTBEAT_ALARM = 'nocap-heartbeat';
const EXT_ORIGIN = chrome.runtime.getURL('');
const QUIET_MS = 8000; // ignore events right after a browser restart / extension reload

// ---------------------------------------------------------------------------
// Storage helpers and the serialized mutation queue
// ---------------------------------------------------------------------------

async function getSettings() {
  const o = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(o[SETTINGS_KEY] || {}) };
}

async function getSession() {
  const o = await chrome.storage.local.get(SESSION_KEY);
  return o[SESSION_KEY] || null;
}

async function archiveSession(session) {
  const o = await chrome.storage.local.get(ARCHIVE_KEY);
  const archive = o[ARCHIVE_KEY] || [];
  archive.push(session);
  await chrome.storage.local.set({ [ARCHIVE_KEY]: archive });
}

let queue = Promise.resolve();

/**
 * Run fn(ctx) with exclusive access to the session. ctx = { session, settings, effects }.
 * Whatever fn leaves in ctx.session is saved afterwards, then ctx.effects (side effects such
 * as notifications or tab changes) run. Set ctx.session = null to remove the session.
 */
function mutate(fn) {
  const run = queue.then(async () => {
    const [session, settings] = await Promise.all([getSession(), getSettings()]);
    const ctx = { session, settings, effects: [] };
    const result = await fn(ctx);
    if (ctx.session) await chrome.storage.local.set({ [SESSION_KEY]: ctx.session });
    else await chrome.storage.local.remove(SESSION_KEY);
    await updateBadge(ctx.session);
    if (ctx.session) scheduleSync();
    for (const effect of ctx.effects) {
      try {
        await effect();
      } catch (err) {
        console.warn('[NO CAP] side effect failed', err);
      }
    }
    return result;
  });
  queue = run.catch((err) => console.warn('[NO CAP] handler failed', err));
  return run;
}

const isActive = (s) => !!s && (s.status === 'in_progress' || s.status === 'violation');
const isLive = (s) => isActive(s) && Date.now() >= ((s.runtime && s.runtime.quietUntil) || 0);

async function updateBadge(session) {
  let text = '';
  let color = '#1B7F4B';
  if (isActive(session)) {
    const n = session.incidents.length;
    text = n ? String(n) : 'ON';
    color = n ? '#C81E3A' : '#1B7F4B';
  }
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    /* badge is cosmetic */
  }
}

function newSessionId() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `NC-${ymd}-${rand}`;
}

const classify = (session, url) => classifyUrl(url, session.config);

// ---------------------------------------------------------------------------
// Incident logging
// ---------------------------------------------------------------------------

function findMergeTarget(session, { ts, category, domain, tabId }) {
  const recent = session.incidents.slice(-6).reverse();
  return recent.find(
    (i) =>
      // Same moment: tab event + visibility event + URL event for one action.
      Math.abs(i.ts - ts) <= MERGE_MS ||
      // Follow-up navigation inside the same non-exam tab shortly after switching to it.
      (tabId != null && i.tabId === tabId && ts - i.ts >= 0 && ts - i.ts <= 15000) ||
      // The same site reported twice in quick succession.
      (domain && i.category === category && i.domain === domain && Math.abs(i.ts - ts) <= 10000)
  );
}

/**
 * Record an incident, merging it into an existing one when it is the same action.
 * tabId should only be passed for tabs other than the exam tab.
 */
function addIncident(ctx, { category, ts = Date.now(), domain = null, domainCategory = null, detail = '', signal = category, tabId = null }) {
  const s = ctx.session;
  const meta = CATEGORY_META[category];
  const target = findMergeTarget(s, { ts, category, domain, tabId });
  let incident;
  let merged = false;
  let upgraded = false;

  if (target) {
    merged = true;
    incident = target;
    if (!incident.signals.some((x) => x.type === signal && Math.abs(x.ts - ts) <= MERGE_MS)) {
      incident.signals.push({ type: signal, ts });
    }
    if (meta.priority > CATEGORY_META[incident.category].priority) {
      incident.category = category;
      incident.warning = meta.warning;
      upgraded = true;
    }
    if (domain && (upgraded || !incident.domain)) {
      incident.domain = domain;
      incident.domainCategory = domainCategory;
    }
    if (detail && !incident.details.includes(detail)) incident.details.push(detail);
    if (tabId != null) incident.tabId = tabId;
    incident.ts = Math.min(incident.ts, ts);
    incident.ackTs = null;
  } else {
    incident = {
      id: `${s.id}-${String(s.incidents.length + 1).padStart(3, '0')}`,
      ts,
      category,
      warning: meta.warning,
      domain,
      domainCategory,
      details: detail ? [detail] : [],
      signals: [{ type: signal, ts }],
      tabId,
      ackTs: null
    };
    s.incidents.push(incident);
  }

  s.status = 'violation';

  const threshold = s.config.violationThreshold;
  if (threshold > 0 && s.incidents.length >= threshold && !s.flagged) {
    s.flagged = true;
    s.flaggedAt = Date.now();
    s.events.push({
      ts: s.flaggedAt,
      type: 'flagged',
      detail: `Violation threshold (${threshold}) reached. Session flagged for instructor review. This is not a finding of misconduct.`
    });
  }

  if (!merged || upgraded) ctx.effects.push(() => notify(incident));
  return { incident, merged, upgraded };
}

function notify(incident) {
  return chrome.notifications.create(`nocap-${incident.id}-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'NO CAP: incident recorded',
    message: `${incident.warning}\nYour incident has been recorded. Please return to the authorized exam page.`,
    priority: 2
  });
}

async function focusExamTab(tabId, windowId) {
  if (tabId == null) return;
  try {
    await chrome.tabs.update(tabId, { active: true });
    if (windowId != null) await chrome.windows.update(windowId, { focused: true });
  } catch {
    /* tab or window is gone */
  }
}

/** Strict mode helpers: best-effort only; a determined user can still bypass them. */
function strictFocus(ctx) {
  const s = ctx.session;
  if (!s.config.strictMode) return;
  const tabId = s.examTabId;
  const windowId = s.examWindowId;
  ctx.effects.push(() => focusExamTab(tabId, windowId));
}

function strictCloseTab(ctx, tabId) {
  const s = ctx.session;
  if (!s.config.strictMode) return;
  const examTabId = s.examTabId;
  const windowId = s.examWindowId;
  ctx.effects.push(async () => {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* already closed */
    }
    await focusExamTab(examTabId, windowId);
  });
}

function strictGoBack(ctx) {
  const s = ctx.session;
  if (!s.config.strictMode || s.examTabId == null) return;
  const tabId = s.examTabId;
  ctx.effects.push(async () => {
    try {
      // Going back keeps the form page in the history cache, so answers are not discarded.
      await chrome.tabs.goBack(tabId);
    } catch {
      /* nothing to go back to */
    }
  });
}

function tryRebind(ctx, tab, url) {
  const s = ctx.session;
  if (s.examTabId == null && url && isFormMatch(url, s.config.form)) {
    s.examTabId = tab.id;
    s.examWindowId = tab.windowId;
    s.events.push({ ts: Date.now(), type: 'rebound', detail: 'The authorized exam form was reopened and monitoring re-attached to it.' });
    return true;
  }
  return false;
}

/** Log what is known about a non-exam tab the student is looking at. */
function logOtherTab(ctx, tab, ts, trigger) {
  const url = tab.url || tab.pendingUrl || '';
  if (tryRebind(ctx, tab, url)) return;
  const cls = classify(ctx.session, url);
  if (cls.authorized) return; // another tab of the same form or an allowed exception

  const where = cls.domain ? `Switched to ${cls.domain}.` : 'Switched to a tab whose address could not be read.';
  addIncident(ctx, {
    category: 'tab_switch',
    ts,
    domain: cls.domain,
    domainCategory: cls.domainCategory,
    detail: trigger === 'window' ? `Switched to another browser window. ${where}` : where,
    tabId: tab.id
  });
  if (cls.readable && cls.category !== 'unauthorized_url') {
    addIncident(ctx, {
      category: cls.category,
      ts,
      domain: cls.domain,
      domainCategory: cls.domainCategory,
      detail: cls.domainCategory ? `${cls.domainCategory}: ${cls.domain}.` : '',
      tabId: tab.id
    });
  } else if (cls.readable) {
    addIncident(ctx, { category: 'unauthorized_url', ts, domain: cls.domain, detail: `Unauthorized page: ${cls.domain}.`, tabId: tab.id });
  }
  strictFocus(ctx);
}

// ---------------------------------------------------------------------------
// Browser event listeners (registered synchronously at top level, as MV3 requires)
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(({ tabId }) => {
  const ts = Date.now();
  mutate(async (ctx) => {
    const s = ctx.session;
    if (!isLive(s) || tabId === s.examTabId) return;
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
    logOtherTab(ctx, tab, ts, 'tab');
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  const ts = Date.now();
  mutate((ctx) => {
    const s = ctx.session;
    if (!isLive(s)) return;

    // A tab NO CAP itself opened to bring the student back to the exam.
    if (s.expectedNewTabUntil && ts < s.expectedNewTabUntil) {
      s.expectedNewTabUntil = 0;
      s.examTabId = tab.id;
      s.examWindowId = tab.windowId;
      s.events.push({ ts, type: 'rebound', detail: 'The exam form was reopened from NO CAP and monitoring re-attached to it.' });
      return;
    }

    const url = tab.pendingUrl || tab.url || '';
    const cls = url ? classify(s, url) : null;
    addIncident(ctx, {
      category: 'new_tab',
      ts,
      domain: cls && cls.readable ? cls.domain : null,
      domainCategory: cls ? cls.domainCategory : null,
      detail: cls && cls.domain ? `New tab opened (${cls.domain}).` : 'New tab opened.',
      tabId: tab.id
    });
    strictCloseTab(ctx, tab.id);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return; // only react to address changes
  const ts = Date.now();
  mutate((ctx) => {
    const s = ctx.session;
    if (!isLive(s)) return;
    const url = changeInfo.url;

    if (tryRebind(ctx, { id: tabId, windowId: tab.windowId }, url)) return;

    const cls = classify(s, url);
    if (tabId === s.examTabId) {
      if (cls.authorized) return;
      addIncident(ctx, {
        category: cls.category,
        ts,
        domain: cls.domain,
        domainCategory: cls.domainCategory,
        detail: `The exam tab navigated away from the authorized form${cls.domain ? ` to ${cls.domain}` : ''}.`
      });
      strictGoBack(ctx);
      return;
    }

    if (!tab.active || cls.authorized) return; // only pages the student is looking at
    addIncident(ctx, {
      category: cls.category,
      ts,
      domain: cls.domain,
      domainCategory: cls.domainCategory,
      detail: `Active tab navigated to ${cls.domain || 'an address that could not be read'}.`,
      tabId
    });
    strictFocus(ctx);
  });
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  const ts = Date.now();
  mutate((ctx) => {
    const s = ctx.session;
    if (!isLive(s) || tabId !== s.examTabId) return;
    s.examTabId = null;
    addIncident(ctx, {
      category: 'exam_tab_closed',
      ts,
      detail: info.isWindowClosing ? 'The exam window was closed.' : 'The exam tab was closed before the session ended.'
    });
  });
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  // Chrome occasionally swaps a tab for a prerendered/discarded one; keep following the exam.
  mutate((ctx) => {
    const s = ctx.session;
    if (isActive(s) && s.examTabId === removedTabId) s.examTabId = addedTabId;
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  const ts = Date.now();
  mutate(async (ctx) => {
    const s = ctx.session;
    if (!isLive(s)) return;

    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      // Chrome lost focus. We cannot know where focus went, so only record the moment.
      if (!s.runtime.focusLostAt) s.runtime.focusLostAt = ts;
      return;
    }

    if (s.runtime.focusLostAt) {
      const lostAt = s.runtime.focusLostAt;
      s.runtime.focusLostAt = null;
      const duration = ts - lostAt;
      if (duration >= s.config.graceSeconds * 1000) {
        addIncident(ctx, {
          category: 'window_focus_lost',
          ts: lostAt,
          signal: 'window_focus_lost',
          detail: `The browser window lost focus for ${formatDuration(duration)}. Which application received focus cannot be determined.`
        });
      } else {
        s.ignoredFocusBlips = (s.ignoredFocusBlips || 0) + 1;
      }
    }

    // Focus moved to a different Chrome window: look at what that window is showing.
    if (windowId !== s.examWindowId) {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab && tab.id !== s.examTabId) logOtherTab(ctx, tab, ts, 'window');
    }
  });
});

// Heartbeat: lets us measure how long monitoring was interrupted after a crash or restart.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  mutate((ctx) => {
    if (isActive(ctx.session)) ctx.session.lastHeartbeat = Date.now();
  });
});

chrome.notifications.onClicked.addListener(() => {
  returnToExam().catch(() => {});
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const o = await chrome.storage.local.get(SETTINGS_KEY);
  if (!o[SETTINGS_KEY]) await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  if (details.reason !== 'install') recover('extension reloaded or updated');
});

chrome.runtime.onStartup.addListener(() => recover('browser restarted'));

/** Called when the browser or extension restarts while a session is still marked active. */
async function recover(reason) {
  await mutate(async (ctx) => {
    const s = ctx.session;
    if (!isActive(s)) return;
    const now = Date.now();
    const gap = now - (s.lastHeartbeat || s.startedAt);
    s.runtime = { focusLostAt: null, quietUntil: now + QUIET_MS };
    s.interruptions = (s.interruptions || 0) + 1;
    s.events.push({
      ts: now,
      type: 'interrupted',
      detail: `Monitoring was interrupted (${reason}) for about ${formatDuration(gap)}. Activity during that time was not recorded. If this was an extension reload, reload the exam page to restore the in-page indicator.`
    });

    // Tab IDs change after a browser restart, so find the exam form again.
    const tabs = await chrome.tabs.query({});
    const form = s.config.form;
    const stillValid = s.examTabId != null && tabs.some((t) => t.id === s.examTabId && t.url && isFormMatch(t.url, form));
    if (!stillValid) {
      const match = tabs.find((t) => t.url && isFormMatch(t.url, form));
      s.examTabId = match ? match.id : null;
      s.examWindowId = match ? match.windowId : null;
    }
    ctx.effects.push(() => chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 }));
  });
}

// ---------------------------------------------------------------------------
// Messages from the content script, popup, options page and review page
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // keep the channel open for the async response
});

async function handleMessage(msg, sender) {
  const fromExtensionPage = !!sender.url && sender.url.startsWith(EXT_ORIGIN);
  const tabId = sender.tab ? sender.tab.id : null;
  const deny = { ok: false, error: 'Not allowed from this context.' };

  switch (msg && msg.type) {
    case 'hello':
      return { ok: true, tabId };
    case 'visibility':
      return onVisibility(msg, tabId);
    case 'formResponse':
      return onFormResponse(tabId);
    case 'ack':
      return acknowledge(false);

    // Everything below can only be triggered from the extension's own pages.
    case 'returnToExam':
      return fromExtensionPage ? acknowledge(true) : deny;
    case 'saveSettings':
      return fromExtensionPage ? saveSettings(msg.settings || {}) : deny;
    case 'startExam':
      return fromExtensionPage ? startExam(!!msg.rulesAccepted) : deny;
    case 'endExam':
      return fromExtensionPage ? endExam() : deny;
    case 'resetData':
      return fromExtensionPage ? resetData(msg.what) : deny;
    case 'connect':
      return fromExtensionPage ? connectDashboard(msg) : deny;
    case 'disconnect':
      return fromExtensionPage ? disconnectDashboard() : deny;
    default:
      return { ok: false, error: 'Unknown message.' };
  }
}

function onVisibility(msg, tabId) {
  const ts = Number(msg.ts) || Date.now();
  return mutate((ctx) => {
    const s = ctx.session;
    if (!isLive(s) || tabId == null || tabId !== s.examTabId) return { ok: true };

    if (msg.state === 'hidden') {
      addIncident(ctx, {
        category: 'visibility_hidden',
        ts,
        signal: 'visibility_hidden',
        detail: 'The exam page became hidden (tab switched, window minimized or covered).'
      });
    } else if (msg.state === 'visible') {
      for (const inc of [...s.incidents].reverse()) {
        const sig = inc.signals.find((x) => x.type === 'visibility_hidden' && !x.endedTs);
        if (sig) {
          sig.endedTs = ts;
          break;
        }
      }
    }
    return { ok: true };
  });
}

function onFormResponse(tabId) {
  return mutate((ctx) => {
    const s = ctx.session;
    if (!isLive(s) || tabId !== s.examTabId || s.formResponseSeen) return { ok: true };
    s.formResponseSeen = true;
    s.events.push({
      ts: Date.now(),
      type: 'form_response_page',
      detail: 'The Google Forms confirmation page was reached. This suggests the form was submitted; Google Forms remains the source of truth.'
    });
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Optional instructor dashboard (opt-in; the student connects explicitly)
// ---------------------------------------------------------------------------
//
// When connected, the full session snapshot (incident categories, times and domains; no
// URLs, answers or tab ids) is POSTed to the instructor's dashboard after every change and
// every 30 s heartbeat. Snapshots are idempotent, so a failed request is simply repeated by
// the next one. Nothing is sent unless the student has connected and consented.

async function getConnection() {
  const o = await chrome.storage.local.get(CONNECTION_KEY);
  return o[CONNECTION_KEY] || null;
}

async function postJson(origin, path, body, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(origin + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** The only session data that ever leaves the device. */
function buildSnapshot(s) {
  return {
    id: s.id,
    status: s.status,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    lastHeartbeat: s.lastHeartbeat,
    flagged: s.flagged,
    flaggedAt: s.flaggedAt,
    threshold: s.config.violationThreshold,
    interruptions: s.interruptions || 0,
    ignoredFocusBlips: s.ignoredFocusBlips || 0,
    formResponseSeen: !!s.formResponseSeen,
    incidents: s.incidents.map((i) => ({
      id: i.id,
      ts: i.ts,
      category: i.category,
      warning: i.warning,
      domain: i.domain,
      domainCategory: i.domainCategory,
      details: i.details,
      signals: i.signals,
      ackTs: i.ackTs
    })),
    events: s.events
  };
}

let syncing = false;
let syncDirty = false;

function scheduleSync() {
  syncNow().catch(() => {});
}

async function syncNow() {
  if (syncing) {
    syncDirty = true;
    return;
  }
  syncing = true;
  try {
    do {
      syncDirty = false;
      await pushSnapshot();
    } while (syncDirty);
  } finally {
    syncing = false;
  }
}

async function pushSnapshot() {
  const [conn, session] = await Promise.all([getConnection(), getSession()]);
  if (!conn || !session) return;
  let lastError = null;
  try {
    const res = await postJson(conn.origin, '/api/sync', { token: conn.token, session: buildSnapshot(session) });
    if (res.status === 401 || res.status === 404) lastError = 'The dashboard no longer accepts this connection. Reconnect in NO CAP settings.';
    else if (res.status !== 200) lastError = (res.data && res.data.error) || `Dashboard returned ${res.status}.`;
  } catch {
    lastError = 'The dashboard could not be reached. NO CAP will keep retrying.';
  }
  const latest = (await getConnection()) || conn;
  await chrome.storage.local.set({
    [CONNECTION_KEY]: { ...latest, lastError, lastSyncAt: lastError ? latest.lastSyncAt : Date.now() }
  });
}

/** Ask the dashboard for the exam's current rules. Returns { connected, exam|null }. */
async function fetchPolicy() {
  const conn = await getConnection();
  if (!conn) return { connected: false, exam: null };
  try {
    const res = await postJson(conn.origin, '/api/policy', { token: conn.token }, 4000);
    if (res.status === 200 && res.data.exam) return { connected: true, exam: res.data.exam };
  } catch {
    /* fall through */
  }
  return { connected: true, exam: null };
}

async function connectDashboard({ server, code, name, studentId, consent }) {
  if (isActive(await getSession())) return { ok: false, error: 'Connections cannot be changed during an exam.' };
  if (consent !== true) return { ok: false, error: 'Tick the consent box to connect.' };

  const v = validateServerUrl(server);
  if (!v.ok) return { ok: false, error: v.error };
  const cleanName = String(name || '').trim().slice(0, 80);
  if (!cleanName) return { ok: false, error: 'Enter your name so your instructor can identify you.' };
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(cleanCode)) return { ok: false, error: 'The join code has 6 letters and numbers.' };
  if (!(await chrome.permissions.contains({ origins: [v.pattern] }))) {
    return { ok: false, error: 'Chrome has not allowed NO CAP to contact that address.' };
  }

  let res;
  try {
    res = await postJson(v.origin, '/api/join', { code: cleanCode, name: cleanName, studentId: String(studentId || '').trim(), consent: true });
  } catch {
    return { ok: false, error: 'Could not reach the dashboard. Check the address and your network.' };
  }
  if (res.status !== 200) return { ok: false, error: (res.data && res.data.error) || `Dashboard returned ${res.status}.` };

  const { token, exam } = res.data;
  const connection = {
    origin: v.origin,
    examId: exam.id,
    examTitle: exam.title,
    studentName: cleanName,
    studentId: String(studentId || '').trim(),
    token,
    joinedAt: Date.now(),
    lastSyncAt: null,
    lastError: null
  };
  await chrome.storage.local.set({ [CONNECTION_KEY]: connection });

  // The teacher's form and rules replace whatever was saved locally.
  const partial = {
    strictMode: exam.policy.strictMode,
    graceSeconds: exam.policy.graceSeconds,
    violationThreshold: exam.policy.violationThreshold,
    prohibited: exam.policy.prohibited,
    allowedHosts: exam.policy.allowedHosts
  };
  if (exam.formUrl) partial.examUrl = exam.formUrl;
  await saveSettings(partial);
  return { ok: true, examTitle: exam.title };
}

async function disconnectDashboard() {
  if (isActive(await getSession())) return { ok: false, error: 'Connections cannot be changed during an exam.' };
  await chrome.storage.local.remove(CONNECTION_KEY);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

async function saveSettings(partial) {
  const session = await getSession();
  if (isActive(session)) return { ok: false, error: 'Settings are locked while an exam is in progress.' };

  const current = await getSettings();
  const next = { ...current };

  if ('examUrl' in partial) {
    const parsed = parseFormUrl(partial.examUrl);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    next.examUrl = parsed.canonical;
  }
  if ('strictMode' in partial) next.strictMode = !!partial.strictMode;
  if ('graceSeconds' in partial) next.graceSeconds = clampInt(partial.graceSeconds, 0, 30, current.graceSeconds);
  if ('violationThreshold' in partial) next.violationThreshold = clampInt(partial.violationThreshold, 0, 99, current.violationThreshold);

  if ('prohibited' in partial) {
    if (!Array.isArray(partial.prohibited)) return { ok: false, error: 'Prohibited list is invalid.' };
    const seen = new Set();
    next.prohibited = [];
    for (const p of partial.prohibited) {
      const domain = normalizeDomain(p && p.domain);
      if (!domain) return { ok: false, error: `“${p && p.domain}” is not a valid domain.` };
      if (seen.has(domain)) continue;
      seen.add(domain);
      next.prohibited.push({ domain, category: String((p && p.category) || 'Prohibited').slice(0, 40) });
    }
  }
  if ('allowedHosts' in partial) {
    if (!Array.isArray(partial.allowedHosts)) return { ok: false, error: 'Allowed list is invalid.' };
    const hosts = [];
    for (const raw of partial.allowedHosts) {
      const host = normalizeDomain(raw);
      if (!host) return { ok: false, error: `“${raw}” is not a valid domain.` };
      if (!hosts.includes(host)) hosts.push(host);
    }
    next.allowedHosts = hosts;
  }

  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return { ok: true, settings: next };
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function startExam(rulesAccepted) {
  if (!rulesAccepted) return { ok: false, error: 'Read and accept the examination rules first.' };

  // If connected, fetch the teacher's current rules first (network call kept outside the queue).
  const remote = await fetchPolicy();

  return mutate(async (ctx) => {
    if (isActive(ctx.session)) return { ok: false, error: 'An exam session is already running.' };

    const settings = { ...ctx.settings };
    let policyEvent = null;
    if (remote.exam) {
      const pol = remote.exam.policy || {};
      settings.strictMode = !!pol.strictMode;
      settings.graceSeconds = Number.isFinite(pol.graceSeconds) ? pol.graceSeconds : settings.graceSeconds;
      settings.violationThreshold = Number.isFinite(pol.violationThreshold) ? pol.violationThreshold : settings.violationThreshold;
      if (Array.isArray(pol.prohibited)) settings.prohibited = pol.prohibited;
      if (Array.isArray(pol.allowedHosts)) settings.allowedHosts = pol.allowedHosts;
      if (remote.exam.formUrl && parseFormUrl(remote.exam.formUrl).ok) settings.examUrl = remote.exam.formUrl;
      policyEvent = 'The instructor’s dashboard supplied the exam rules for this session.';
    } else if (remote.connected) {
      policyEvent = 'The instructor’s dashboard could not be reached at start, so the rules saved on this device were used.';
    }
    const parsed = parseFormUrl(settings.examUrl);
    if (!parsed.ok) return { ok: false, error: 'Save a valid Google Forms link first.' };

    const tabs = await chrome.tabs.query({});
    const win = await chrome.windows.getLastFocused().catch(() => null);
    const matches = tabs.filter((t) => t.url && isFormMatch(t.url, parsed));
    if (!matches.length) return { ok: false, error: 'Open the authorized exam form first, then press Start Exam.' };
    const examTab = matches.find((t) => t.active && win && t.windowId === win.id);
    if (!examTab) return { ok: false, error: 'Switch to the exam form tab in this window, then press Start Exam.' };

    if (ctx.session) await archiveSession(ctx.session); // keep earlier logs

    const now = Date.now();
    ctx.session = {
      id: newSessionId(),
      status: 'in_progress',
      startedAt: now,
      endedAt: null,
      rulesAcceptedAt: now,
      examTabId: examTab.id,
      examWindowId: examTab.windowId,
      lastHeartbeat: now,
      flagged: false,
      flaggedAt: null,
      interruptions: 0,
      ignoredFocusBlips: 0,
      formResponseSeen: false,
      expectedNewTabUntil: 0,
      runtime: { focusLostAt: null, quietUntil: 0 },
      // Settings are frozen for the session so they cannot be changed mid-exam.
      config: {
        examUrl: parsed.canonical,
        form: { id: parsed.id, prefix: parsed.prefix },
        strictMode: settings.strictMode,
        graceSeconds: settings.graceSeconds,
        violationThreshold: settings.violationThreshold,
        prohibited: settings.prohibited,
        allowedHosts: settings.allowedHosts
      },
      incidents: [],
      events: [{ ts: now, type: 'started', detail: 'Student accepted the rules and started the exam session.' }]
    };
    if (policyEvent) ctx.session.events.push({ ts: now, type: 'policy', detail: policyEvent });
    ctx.effects.push(() => chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 }));
    return { ok: true };
  });
}

async function endExam() {
  return mutate((ctx) => {
    const s = ctx.session;
    if (!isActive(s)) return { ok: false, error: 'No exam is running.' };
    s.status = 'ended';
    s.endedAt = Date.now();
    s.runtime = { focusLostAt: null, quietUntil: 0 };
    s.events.push({ ts: s.endedAt, type: 'ended', detail: 'The exam session was ended.' });
    ctx.effects.push(() => chrome.alarms.clear(HEARTBEAT_ALARM));
    return { ok: true };
  });
}

/** Student acknowledges the warning. Incidents are kept; they are only marked as acknowledged. */
async function acknowledge(focusExam) {
  return mutate(async (ctx) => {
    const s = ctx.session;
    if (!isActive(s)) return { ok: false, error: 'No exam is running.' };
    const now = Date.now();
    for (const inc of s.incidents) if (!inc.ackTs) inc.ackTs = now;
    if (s.status === 'violation') s.status = 'in_progress';
    if (!focusExam) return { ok: true };

    let exists = false;
    if (s.examTabId != null) {
      try {
        const t = await chrome.tabs.get(s.examTabId);
        s.examWindowId = t.windowId;
        exists = true;
      } catch {
        s.examTabId = null;
      }
    }
    if (exists) {
      const tabId = s.examTabId;
      const windowId = s.examWindowId;
      ctx.effects.push(() => focusExamTab(tabId, windowId));
    } else {
      s.expectedNewTabUntil = now + 6000;
      const url = s.config.examUrl;
      ctx.effects.push(() => chrome.tabs.create({ url, active: true }));
    }
    return { ok: true };
  });
}

async function returnToExam() {
  return acknowledge(true);
}

async function resetData(what) {
  const session = await getSession();
  if (isActive(session)) return { ok: false, error: 'End the exam before deleting data.' };
  return mutate((ctx) => {
    ctx.session = null;
    ctx.effects.push(async () => {
      await chrome.storage.local.remove(ARCHIVE_KEY);
      if (what === 'everything') await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    });
    return { ok: true };
  });
}
