// options.js — detection settings, domain lists, local data reset.
import { DEFAULT_SETTINGS, normalizeDomain, validateServerUrl, h } from './shared.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e) }));

let draft = { ...DEFAULT_SETTINGS };
let locked = false;
let connection = null;
const armed = new Map();

function setMsg(node, text, kind) {
  node.textContent = text || '';
  node.className = `msg${kind ? ' ' + kind : ''}`;
}

async function load() {
  const stored = await chrome.storage.local.get(['settings', 'session', 'connection']);
  draft = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  draft.prohibited = draft.prohibited.map((p) => ({ ...p }));
  draft.allowedHosts = [...draft.allowedHosts];
  const s = stored.session;
  locked = !!s && (s.status === 'in_progress' || s.status === 'violation');
  connection = stored.connection || null;
  render();
}

function render() {
  renderDashboard();
  $('lockNote').hidden = !locked;
  $('strict').checked = !!draft.strictMode;
  $('grace').value = draft.graceSeconds;
  $('threshold').value = draft.violationThreshold;

  renderList($('prohibitedList'), draft.prohibited, (p, i) =>
    h('li', {},
      h('span', {}, h('strong', { text: p.domain }), h('span', { class: 'cat', text: p.category })),
      h('button', {
        class: 'btn small',
        type: 'button',
        'aria-label': `Remove ${p.domain}`,
        disabled: locked,
        text: 'Remove',
        onclick: () => {
          draft.prohibited.splice(i, 1);
          render();
        }
      })
    ), 'No prohibited websites configured.');

  renderList($('allowedList'), draft.allowedHosts, (host, i) =>
    h('li', {},
      h('strong', { text: host }),
      h('button', {
        class: 'btn small',
        type: 'button',
        'aria-label': `Remove ${host}`,
        disabled: locked,
        text: 'Remove',
        onclick: () => {
          draft.allowedHosts.splice(i, 1);
          render();
        }
      })
    ), 'No exceptions. Only the exam form is allowed.');

  for (const id of ['strict', 'grace', 'threshold', 'pDomain', 'pCategory', 'addProhibited', 'aDomain', 'addAllowed', 'save', 'wipeLogs', 'wipeAll']) {
    $(id).disabled = locked;
  }
}

function renderList(ul, items, build, emptyText) {
  ul.replaceChildren();
  if (!items.length) ul.append(h('li', { class: 'empty', text: emptyText }));
  items.forEach((item, i) => ul.append(build(item, i)));
}

$('addProhibited').addEventListener('click', () => {
  const domain = normalizeDomain($('pDomain').value);
  if (!domain) return setMsg($('saveMsg'), 'Enter a valid domain such as example.com.', 'error');
  if (!draft.prohibited.some((p) => p.domain === domain)) {
    draft.prohibited.push({ domain, category: $('pCategory').value.trim() || 'Prohibited' });
  }
  $('pDomain').value = '';
  $('pCategory').value = '';
  setMsg($('saveMsg'), 'Added. Press Save settings to keep the change.', '');
  render();
});

$('addAllowed').addEventListener('click', () => {
  const domain = normalizeDomain($('aDomain').value);
  if (!domain) return setMsg($('saveMsg'), 'Enter a valid domain such as example.com.', 'error');
  if (!draft.allowedHosts.includes(domain)) draft.allowedHosts.push(domain);
  $('aDomain').value = '';
  setMsg($('saveMsg'), 'Added. Press Save settings to keep the change.', '');
  render();
});

$('save').addEventListener('click', async () => {
  const res = await send({
    type: 'saveSettings',
    settings: {
      strictMode: $('strict').checked,
      graceSeconds: $('grace').value,
      violationThreshold: $('threshold').value,
      prohibited: draft.prohibited,
      allowedHosts: draft.allowedHosts
    }
  });
  if (!res.ok) return setMsg($('saveMsg'), res.error, 'error');
  setMsg($('saveMsg'), 'Settings saved.', 'ok');
  await load();
});

// Two-press confirmation for destructive actions.
function confirmable(id, label, action) {
  const btn = $(id);
  btn.addEventListener('click', async () => {
    if (!armed.get(id)) {
      armed.set(id, setTimeout(() => disarm(id, label), 5000));
      btn.textContent = 'Press again to confirm';
      btn.classList.add('armed');
      return;
    }
    disarm(id, label);
    const res = await action();
    setMsg($('dataMsg'), res.ok ? 'Done.' : res.error, res.ok ? 'ok' : 'error');
    await load();
  });
}

function disarm(id, label) {
  clearTimeout(armed.get(id));
  armed.delete(id);
  const btn = $(id);
  btn.textContent = label;
  btn.classList.remove('armed');
}

confirmable('wipeLogs', 'Delete all session logs', () => send({ type: 'resetData', what: 'logs' }));
confirmable('wipeAll', 'Delete logs and restore defaults', () => send({ type: 'resetData', what: 'everything' }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.session) load();
});

// ----- instructor dashboard connection -----

function renderDashboard() {
  const connected = !!connection;
  $('dashConnected').hidden = !connected;
  $('dashForm').hidden = connected;
  if (connected) {
    $('dashTitle').textContent = `Connected to “${connection.examTitle}” as ${connection.studentName}`;
    $('dashOrigin').textContent = connection.origin;
    $('dashDetail').textContent = connection.lastSyncAt
      ? `Last report sent ${new Date(connection.lastSyncAt).toLocaleTimeString()}. Reports are sent while an exam session runs.`
      : 'No report sent yet. Reports are sent while an exam session runs.';
    $('dashError').textContent = connection.lastError || '';
  }
  for (const id of ['dashConnect', 'dashDisconnect', 'dServer', 'dCode', 'dName', 'dStudentId', 'dConsent']) $(id).disabled = locked;
}

$('dashConnect').addEventListener('click', async () => {
  const msg = $('dashMsg');
  setMsg(msg, '', '');
  const v = validateServerUrl($('dServer').value);
  if (!v.ok) return setMsg(msg, v.error, 'error');
  if (!$('dConsent').checked) return setMsg(msg, 'Tick the consent box to connect.', 'error');

  // Must run directly inside the click so Chrome accepts the permission prompt.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [v.pattern] });
  } catch (err) {
    return setMsg(msg, `Chrome could not ask for permission: ${err.message}`, 'error');
  }
  if (!granted) return setMsg(msg, 'Permission was not granted, so NO CAP cannot contact the dashboard.', 'error');

  setMsg(msg, 'Connecting…', '');
  const res = await send({
    type: 'connect',
    server: $('dServer').value,
    code: $('dCode').value,
    name: $('dName').value,
    studentId: $('dStudentId').value,
    consent: $('dConsent').checked
  });
  if (!res.ok) return setMsg(msg, res.error, 'error');
  setMsg(msg, `Connected to “${res.examTitle}”.`, 'ok');
  $('dConsent').checked = false;
  await load();
});

$('dashDisconnect').addEventListener('click', async () => {
  const res = await send({ type: 'disconnect' });
  if (!res.ok) return setMsg($('dashMsg'), res.error, 'error');
  await load();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.connection) {
    connection = changes.connection.newValue || null;
    renderDashboard();
  }
});

load();
