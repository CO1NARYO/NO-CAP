// popup.js — setup, start/end, live status.
import {
  DEFAULT_SETTINGS,
  STATUS_LABEL,
  CATEGORY_META,
  parseFormUrl,
  isFormMatch,
  formatDuration,
  formatDateTime,
  h
} from './shared.js';

const $ = (id) => document.getElementById(id);

let state = { session: null, settings: { ...DEFAULT_SETTINGS }, connection: null, formTabOpen: false, otherTabs: 0 };
let endArmed = false;
let endTimer = null;

const isActive = (s) => !!s && (s.status === 'in_progress' || s.status === 'violation');
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e) }));

async function refresh() {
  const stored = await chrome.storage.local.get(['session', 'settings', 'connection']);
  state.session = stored.session || null;
  state.connection = stored.connection || null;
  state.settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };

  const parsed = parseFormUrl(state.settings.examUrl);
  const tabs = await chrome.tabs.query({});
  state.formTabOpen = parsed.ok && tabs.some((t) => t.url && isFormMatch(t.url, parsed));
  state.otherTabs = Math.max(0, tabs.length - (state.formTabOpen ? 1 : 0));
  render();
}

function shortUrl(url) {
  if (!url) return '';
  const m = /^https:\/\/(docs\.google\.com)(.*\/forms\/d\/e\/)([^/]+)(\/.*)$/.exec(url);
  if (!m) return url;
  const id = m[3].length > 14 ? `${m[3].slice(0, 8)}…${m[3].slice(-4)}` : m[3];
  return `${m[1]}${m[2]}${id}${m[4]}`;
}

function setMsg(node, text, kind) {
  node.textContent = text || '';
  node.className = `msg${kind ? ' ' + kind : ''}`;
}

function render() {
  const s = state.session;
  const status = s ? s.status : 'not_started';
  const active = isActive(s);

  for (const li of $('bubbles').children) {
    const on = li.dataset.state === status;
    li.classList.toggle('on', on);
    if (on) li.setAttribute('aria-current', 'true');
    else li.removeAttribute('aria-current');
  }

  // Warning panel
  const pending = s && s.status === 'violation' ? [...s.incidents].reverse().find((i) => !i.ackTs) : null;
  $('warningPanel').hidden = !pending;
  if (pending) {
    $('warnMessage').textContent = pending.warning;
    $('warnMeta').textContent = `Incident ${s.incidents.length} recorded ${formatDateTime(pending.ts)}. Your incident has been recorded. Please return to the authorized exam page.`;
  }

  // Run panel
  $('runPanel').hidden = !active;
  if (active) renderRun(s);

  // Ended panel
  $('endedPanel').hidden = status !== 'ended';
  if (status === 'ended') {
    const flagged = s.flagged ? ' This session is flagged for instructor review.' : '';
    $('endedSummary').textContent = `Session ${s.id} ran ${formatDuration(s.endedAt - s.startedAt)} with ${s.incidents.length} recorded incident${s.incidents.length === 1 ? '' : 's'}.${flagged}`;
  }

  // Form setup
  const saved = state.settings.examUrl;
  $('savedRow').hidden = !saved;
  $('savedUrl').textContent = shortUrl(saved);
  $('setupFields').hidden = active;
  if (document.activeElement !== $('examUrl') && !active) {
    if (!$('examUrl').value) $('examUrl').value = saved;
  }

  // Rules + start
  $('rulesPanel').hidden = active;
  updateStart();

  // Instructor dashboard
  const conn = state.connection;
  $('ruleDash').hidden = !conn;
  if (conn) $('ruleDash').textContent = `Your name and incident records (times, categories, website domains) are sent live to your instructor’s dashboard for “${conn.examTitle}”.`;
  $('connectBtn').hidden = !!conn || active;
  $('dashStatus').textContent = conn
    ? conn.lastError
      ? `Dashboard: ${conn.lastError}`
      : `Connected to “${conn.examTitle}”${conn.lastSyncAt ? `. Last report ${new Date(conn.lastSyncAt).toLocaleTimeString()}.` : '.'}`
    : '';

  // Footer
  $('openLog').disabled = active;
  $('openSettings').disabled = active;
  $('logNote').textContent = active
    ? 'The full log opens after the exam ends, so viewing it never disturbs the exam page.'
    : 'Logs stay on this device. They support an instructor’s review and are not proof of cheating.';
}

function renderRun(s) {
  $('statCount').textContent = String(s.incidents.length);
  $('statTime').textContent = formatDuration(Date.now() - s.startedAt);
  const t = s.config.violationThreshold;
  const flag = $('statFlag');
  flag.textContent = s.flagged ? 'Flagged' : t > 0 ? `At ${t}` : 'Off';
  flag.classList.toggle('flagged', !!s.flagged);

  const recent = $('recent');
  recent.replaceChildren();
  const items = [...s.incidents].reverse().slice(0, 3);
  if (!items.length) {
    recent.append(h('p', { class: 'small', text: 'No incidents recorded.' }));
  }
  for (const inc of items) {
    recent.append(
      h('div', { class: 'item' },
        h('span', { text: CATEGORY_META[inc.category].label + (inc.domain ? ` (${inc.domain})` : '') }),
        h('span', { class: 'when', text: new Date(inc.ts).toLocaleTimeString() })
      )
    );
  }
}

function updateStart() {
  const btn = $('startBtn');
  const msg = $('startMsg');
  const saved = parseFormUrl(state.settings.examUrl);
  let hint = '';
  if (!saved.ok) hint = 'Save the exam form link first.';
  else if (!state.formTabOpen) hint = 'Open the authorized exam form in this window, then return here.';
  else if (!$('accept').checked) hint = 'Accept the rules to enable Start Exam.';
  btn.disabled = !!hint;
  if (!msg.dataset.sticky) {
    if (hint) setMsg(msg, hint, 'hint');
    else if (state.otherTabs > 0) {
      setMsg(msg, `${state.otherTabs} other tab${state.otherTabs === 1 ? ' is' : 's are'} open. Switching to them will be recorded. Closing them first is recommended.`, 'hint');
    } else setMsg(msg, 'Ready. Starting begins monitoring.', 'ok');
  }
}

// ----- events -----

$('useTab').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const parsed = parseFormUrl(tab && tab.url);
  if (!parsed.ok) return setMsg($('urlMsg'), parsed.error, 'error');
  $('examUrl').value = parsed.canonical;
  await saveUrl();
});

$('saveUrl').addEventListener('click', saveUrl);

async function saveUrl() {
  const res = await send({ type: 'saveSettings', settings: { examUrl: $('examUrl').value } });
  if (!res.ok) return setMsg($('urlMsg'), res.error, 'error');
  $('examUrl').value = res.settings.examUrl;
  setMsg($('urlMsg'), 'Link saved.', 'ok');
  await refresh();
}

$('accept').addEventListener('change', updateStart);

$('startBtn').addEventListener('click', async () => {
  const msg = $('startMsg');
  delete msg.dataset.sticky;
  const res = await send({ type: 'startExam', rulesAccepted: $('accept').checked });
  if (!res.ok) {
    msg.dataset.sticky = '1';
    return setMsg(msg, res.error, 'error');
  }
  $('accept').checked = false;
  await refresh();
});

$('endBtn').addEventListener('click', async () => {
  const btn = $('endBtn');
  if (!endArmed) {
    endArmed = true;
    btn.textContent = 'Press again to end the exam';
    btn.classList.add('armed');
    endTimer = setTimeout(disarmEnd, 5000);
    return;
  }
  disarmEnd();
  await send({ type: 'endExam' });
  await refresh();
});

function disarmEnd() {
  endArmed = false;
  clearTimeout(endTimer);
  const btn = $('endBtn');
  btn.textContent = 'End Exam';
  btn.classList.remove('armed');
}

$('returnBtn').addEventListener('click', async () => {
  await send({ type: 'returnToExam' });
  window.close();
});

$('openLog').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
});

$('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('connectBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.session || changes.settings || changes.connection)) refresh();
});

setInterval(() => {
  if (isActive(state.session)) renderRun(state.session);
}, 1000);

refresh();
