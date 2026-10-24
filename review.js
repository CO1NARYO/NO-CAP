// review.js — local instructor review screen.
import {
  CATEGORY_META,
  STATUS_LABEL,
  isConfirmed,
  evidenceNote,
  formatDateTime,
  formatDuration,
  csvCell,
  h
} from './shared.js';

const $ = (id) => document.getElementById(id);

let sessions = [];
let selectedId = null;

const SIGNAL_LABEL = {
  tab_switch: 'tab switched',
  new_tab: 'new tab opened',
  unauthorized_url: 'unauthorized page',
  prohibited_site: 'prohibited site',
  local_or_pdf: 'local file or PDF',
  exam_tab_closed: 'exam tab closed',
  visibility_hidden: 'exam page hidden',
  window_focus_lost: 'window lost focus'
};

async function load() {
  const stored = await chrome.storage.local.get(['session', 'archive']);
  sessions = [...(stored.archive || [])];
  if (stored.session) sessions.push(stored.session);
  sessions.sort((a, b) => b.startedAt - a.startedAt);

  if (!sessions.some((s) => s.id === selectedId)) selectedId = sessions[0] ? sessions[0].id : null;
  renderPicker();
  renderSession();
}

function renderPicker() {
  const select = $('sessionSelect');
  select.replaceChildren();
  if (!sessions.length) {
    select.append(h('option', { text: 'No sessions recorded' }));
    select.disabled = true;
  } else {
    select.disabled = false;
    for (const s of sessions) {
      const label = `${s.id}  ·  ${formatDateTime(s.startedAt)}  ·  ${s.incidents.length} incident${s.incidents.length === 1 ? '' : 's'}`;
      select.append(h('option', { value: s.id, text: label, selected: s.id === selectedId }));
    }
  }
  for (const id of ['exportCsv', 'exportJson', 'print']) $(id).disabled = !sessions.length;
}

function renderSession() {
  const main = $('main');
  main.replaceChildren();
  const s = sessions.find((x) => x.id === selectedId);
  if (!s) {
    main.append(h('p', { class: 'empty', text: 'No exam sessions have been recorded yet. Start an exam from the NO CAP popup and the log will appear here.' }));
    return;
  }

  const end = s.endedAt || null;
  const duration = formatDuration((end || Date.now()) - s.startedAt);
  const interrupted = s.interruptions ? `${s.interruptions} interruption${s.interruptions === 1 ? '' : 's'}` : 'None';

  main.append(
    h('dl', { class: 'summary' },
      field('Session identifier', s.id),
      field('Status', STATUS_LABEL[s.status] || s.status),
      field('Started', formatDateTime(s.startedAt)),
      field('Ended', end ? formatDateTime(end) : 'Still in progress'),
      field('Duration', duration),
      field('Total recorded incidents', String(s.incidents.length)),
      field('Instructor review flag', s.flagged ? `Flagged at ${formatDateTime(s.flaggedAt)}` : 'Not flagged', s.flagged),
      field('Monitoring interruptions', interrupted),
      field('Strict Mode', s.config.strictMode ? 'On' : 'Off'),
      field('Focus grace period', `${s.config.graceSeconds} s`)
    )
  );

  main.append(h('h2', { text: 'Incidents' }));
  if (!s.incidents.length) {
    main.append(h('p', { class: 'empty', text: 'No incidents were recorded during this session.' }));
  } else {
    const rows = [...s.incidents].sort((a, b) => a.ts - b.ts).map((inc, idx) => incidentRow(inc, idx + 1));
    main.append(
      h('div', { class: 'tablewrap' },
        h('table', {},
          h('thead', {}, h('tr', {},
            ['#', 'Time', 'Category', 'Evidence', 'Domain', 'What was and was not confirmed'].map((t) => h('th', { scope: 'col', text: t }))
          )),
          h('tbody', {}, rows)
        )
      )
    );
  }

  main.append(h('h2', { text: 'Session events' }));
  main.append(
    h('ul', { class: 'events' },
      [...s.events].sort((a, b) => a.ts - b.ts).map((e) =>
        h('li', {}, h('time', { text: formatDateTime(e.ts) }), e.detail)
      )
    )
  );

  if (s.ignoredFocusBlips) {
    main.append(h('p', { class: 'lead', text: `${s.ignoredFocusBlips} brief focus loss${s.ignoredFocusBlips === 1 ? '' : 'es'} shorter than the grace period ${s.ignoredFocusBlips === 1 ? 'was' : 'were'} ignored and not counted.` }));
  }
}

function field(label, value, flag) {
  return h('div', {}, h('dt', { text: label }), h('dd', { class: flag ? 'flag' : '', text: value }));
}

function incidentRow(inc, n) {
  const confirmed = isConfirmed(inc);
  const signals = [...inc.signals].sort((a, b) => a.ts - b.ts).map((sig) => {
    const back = sig.endedTs ? ` (returned after ${formatDuration(sig.endedTs - sig.ts)})` : '';
    return h('li', { text: `${new Date(sig.ts).toLocaleTimeString()}: ${SIGNAL_LABEL[sig.type] || sig.type}${back}` });
  });

  return h('tr', {},
    h('td', { text: String(n) }),
    h('td', { text: formatDateTime(inc.ts) }),
    h('td', { text: CATEGORY_META[inc.category].label }),
    h('td', {}, h('span', { class: `badge ${confirmed ? 'detected' : 'unconfirmed'}`, text: confirmed ? 'Detected' : 'Not confirmed' })),
    h('td', { text: inc.domain ? `${inc.domain}${inc.domainCategory ? ` (${inc.domainCategory})` : ''}` : 'Not available' }),
    h('td', {},
      h('p', { class: 'note', text: evidenceNote(inc) }),
      inc.details.length ? h('ul', {}, inc.details.map((d) => h('li', { text: d }))) : null,
      h('ul', {}, signals),
      inc.ackTs ? h('p', { class: 'note', text: `Student acknowledged the warning at ${new Date(inc.ackTs).toLocaleTimeString()}.` }) : null
    )
  );
}

// ----- export -----

function download(filename, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function currentSession() {
  return sessions.find((x) => x.id === selectedId);
}

$('exportJson').addEventListener('click', () => {
  const s = currentSession();
  if (s) download(`${s.id}.json`, 'application/json', JSON.stringify(s, null, 2));
});

$('exportCsv').addEventListener('click', () => {
  const s = currentSession();
  if (!s) return;
  const header = ['session_id', 'incident_number', 'time_iso', 'category', 'evidence', 'domain', 'domain_category', 'details', 'signals'];
  const lines = [header.map(csvCell).join(',')];
  [...s.incidents].sort((a, b) => a.ts - b.ts).forEach((inc, i) => {
    lines.push([
      s.id,
      i + 1,
      new Date(inc.ts).toISOString(),
      CATEGORY_META[inc.category].label,
      isConfirmed(inc) ? 'Detected' : 'Not confirmed',
      inc.domain || '',
      inc.domainCategory || '',
      inc.details.join(' | '),
      inc.signals.map((x) => `${new Date(x.ts).toISOString()} ${x.type}`).join(' | ')
    ].map(csvCell).join(','));
  });
  download(`${s.id}.csv`, 'text/csv', lines.join('\r\n'));
});

$('print').addEventListener('click', () => window.print());

$('sessionSelect').addEventListener('change', (e) => {
  selectedId = e.target.value;
  renderSession();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.session || changes.archive)) load();
});

load();
