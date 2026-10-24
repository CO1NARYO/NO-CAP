// dashboard/public/app.js — teacher dashboard client.
// All dynamic text is inserted as text nodes through the h() helper, never as markup.
import { CATEGORY_META, isConfirmed, evidenceNote, formatDateTime, formatDuration, h } from '/shared.js';

const app = document.getElementById('app');
const STALE_MS = 90 * 1000; // no report for this long while "in progress" => "Not reporting"

const POLL_MS = 3000;

const state = {
  authed: null,
  user: null,
  config: { signupCodeRequired: false, allowedDomains: [] },
  authTab: 'signin',
  showDelete: false,
  cursor: 0,
  retentionDays: 30,
  exams: [],
  defaults: null,
  examId: null,
  exam: null,
  students: new Map(),
  mode: null, // null | 'new' | 'edit'
  filter: { q: '', flagged: false, incidents: false, sort: 'attention' },
  open: new Set(),
  fresh: new Map(),
  sound: false,
  live: 'idle', // idle | live | reconnecting
  poll: null
};
let refs = {};

// ---------------------------------------------------------------- api

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nocap' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (res.status === 401 && data.error === 'Sign in required.') {
    state.authed = false;
    closeStream();
    render();
    throw new Error('Signed out.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// ---------------------------------------------------------------- derived data

function view(s) {
  const sess = s.sessions[0] || null;
  const now = Date.now();
  let conn = { label: 'Joined', cls: '' };
  let status = 'Not started';
  if (sess) {
    if (sess.status === 'ended') {
      conn = { label: 'Finished', cls: 'done' };
      status = 'Ended';
    } else if (now - s.lastSeenAt > STALE_MS) {
      conn = { label: 'Not reporting', cls: 'stale' };
      status = sess.status === 'violation' ? 'Violation detected' : 'In progress';
    } else {
      conn = { label: 'Live', cls: 'live' };
      status = sess.status === 'violation' ? 'Violation detected' : 'In progress';
    }
  }
  const incidents = sess ? [...sess.incidents].sort((a, b) => a.ts - b.ts) : [];
  return { sess, conn, status, incidents, last: incidents[incidents.length - 1] || null };
}

const incidentText = (inc) => CATEGORY_META[inc.category].label + (inc.domain ? ` (${inc.domain})` : '');

function visibleStudents() {
  const f = state.filter;
  const q = f.q.trim().toLowerCase();
  let list = [...state.students.values()].map((s) => ({ s, v: view(s) }));
  if (q) list = list.filter(({ s }) => `${s.name} ${s.studentId}`.toLowerCase().includes(q));
  if (f.flagged) list = list.filter(({ v }) => v.sess && v.sess.flagged);
  if (f.incidents) list = list.filter(({ v }) => v.incidents.length > 0);
  list.sort((a, b) => {
    if (f.sort === 'name') return a.s.name.localeCompare(b.s.name);
    const fa = a.v.sess && a.v.sess.flagged ? 1 : 0;
    const fb = b.v.sess && b.v.sess.flagged ? 1 : 0;
    return fb - fa || b.v.incidents.length - a.v.incidents.length || a.s.name.localeCompare(b.s.name);
  });
  return list;
}

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    const me = await api('GET', '/api/me');
    state.authed = me.authed;
    state.user = me.user;
    state.retentionDays = me.retentionDays;
    state.config = { signupCodeRequired: me.signupCodeRequired, allowedDomains: me.allowedDomains || [] };
    if (state.authed) await loadExams();
  } catch {
    state.authed = false;
  }
  render();
}

async function loadExams() {
  const data = await api('GET', '/api/exams');
  state.exams = data.exams;
  state.defaults = data.defaults;
  if (state.examId && !state.exams.some((e) => e.id === state.examId)) {
    state.examId = null;
    state.exam = null;
  }
}

async function selectExam(id) {
  closeStream();
  state.examId = id;
  state.mode = null;
  state.open.clear();
  await loadExam();
  openStream();
  render();
}

async function loadExam() {
  const data = await api('GET', `/api/exams/${state.examId}`);
  state.exam = data.exam;
  state.students = new Map(data.students.map((s) => [s.id, s]));
  state.cursor = data.students.reduce((max, s) => Math.max(max, s.updatedAt || 0), 0);
}

// Live updates: the dashboard asks for students changed since the last cursor every few seconds.
// (Vercel functions cannot hold a connection open, so polling replaces a push stream.)
function openStream() {
  closeStream();
  if (!state.examId) return;
  state.live = 'live';
  state.poll = setInterval(pollOnce, POLL_MS);
}

function closeStream() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
  state.live = 'idle';
}

let polling = false;
async function pollOnce() {
  if (polling || !state.examId || document.hidden) return;
  polling = true;
  const examId = state.examId;
  try {
    const data = await api('GET', `/api/exams/${examId}/live?since=${state.cursor}`);
    if (examId !== state.examId) return; // the instructor switched exams meanwhile
    state.cursor = data.cursor;
    let changed = false;
    for (const s of data.students) {
      const before = state.students.get(s.id);
      const prevCount = before && before.sessions[0] ? before.sessions[0].incidents.length : 0;
      const nowCount = s.sessions[0] ? s.sessions[0].incidents.length : 0;
      const same = before && JSON.stringify(before) === JSON.stringify(s);
      state.students.set(s.id, s);
      if (nowCount > prevCount) {
        state.fresh.set(s.id, Date.now() + 8000);
        if (state.sound) beep();
      }
      if (!same) changed = true;
    }
    if (state.live !== 'live') {
      state.live = 'live';
      renderLiveBadge();
    }
    if (changed) renderRoster();
  } catch {
    if (state.authed) {
      state.live = 'reconnecting';
      renderLiveBadge();
    }
  } finally {
    polling = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollOnce();
});

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
  } catch {
    /* audio not available */
  }
}

// ---------------------------------------------------------------- rendering

function render() {
  app.replaceChildren();
  refs = {};
  if (state.authed === null) return;
  if (!state.authed) return app.append(authView());

  app.append(
    h('header', { class: 'bar' },
      h('div', {}, h('span', { class: 'wordmark', text: 'NO CAP' }), h('span', { class: 'sub', text: 'Teacher dashboard' })),
      h('div', { class: 'row' },
        (refs.live = h('span', { class: 'conn' })),
        h('span', { class: 'conn', text: state.user ? state.user.name : '' }),
        h('button', { class: 'btn small', type: 'button', text: 'Sign out', onclick: signOut })
      )
    ),
    h('div', { class: 'layout' }, sidebar(), (refs.main = h('main', { class: 'main' })))
  );
  renderMain();
  renderLiveBadge();
}

function renderLiveBadge() {
  if (!refs.live) return;
  refs.live.className = 'conn' + (state.live === 'reconnecting' ? ' bad' : '');
  refs.live.textContent = state.live === 'live' ? 'Live updates on' : state.live === 'reconnecting' ? 'Reconnecting…' : '';
}

function authView() {
  const signup = state.authTab === 'signup';
  const f = {
    name: h('input', { id: 'a-name', type: 'text', maxlength: '80', autocomplete: 'name', required: true }),
    email: h('input', { id: 'a-email', type: 'email', autocomplete: 'email', required: true }),
    pw: h('input', { id: 'a-pw', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', required: true, minlength: signup ? '10' : null }),
    code: h('input', { id: 'a-code', type: 'text', autocomplete: 'off' })
  };
  const msg = h('p', { class: 'msg error', role: 'alert' });
  const tab = (key, label) =>
    h('button', {
      type: 'button',
      class: `tab${state.authTab === key ? ' on' : ''}`,
      'aria-pressed': state.authTab === key ? 'true' : 'false',
      text: label,
      onclick: () => { state.authTab = key; render(); }
    });

  const form = h('form', { class: 'card login' },
    h('h1', { text: 'NO CAP' }),
    h('p', { class: 'muted', text: 'Watch your Google Forms exams live.' }),
    h('div', { class: 'tabs' }, tab('signin', 'Sign in'), tab('signup', 'Create account')),
    signup ? h('div', { class: 'field' }, h('label', { for: 'a-name', text: 'Your name' }), f.name) : null,
    h('div', { class: 'field' }, h('label', { for: 'a-email', text: 'Email' }), f.email,
      signup && state.config.allowedDomains.length ? h('p', { class: 'help', text: `Use an email from: ${state.config.allowedDomains.join(', ')}.` }) : null),
    h('div', { class: 'field' }, h('label', { for: 'a-pw', text: 'Password' }), f.pw,
      signup ? h('p', { class: 'help', text: 'At least 10 characters.' }) : null),
    signup && state.config.signupCodeRequired
      ? h('div', { class: 'field' }, h('label', { for: 'a-code', text: 'Invitation code' }), f.code,
          h('p', { class: 'help', text: 'Ask the person who set up this dashboard for the code.' }))
      : null,
    h('button', { class: 'btn primary', type: 'submit', text: signup ? 'Create account' : 'Sign in' }),
    msg,
    signup ? h('p', { class: 'help', text: 'There is no email reset. If you forget your password, the person who runs this dashboard can set a new one.' }) : null
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    try {
      const res = await api('POST', signup ? '/api/signup' : '/api/login',
        signup
          ? { name: f.name.value, email: f.email.value, password: f.pw.value, code: f.code.value }
          : { email: f.email.value, password: f.pw.value });
      state.authed = true;
      state.user = res.user;
      await loadExams();
      render();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  return form;
}

async function signOut() {
  try {
    await api('POST', '/api/logout', {});
  } catch {
    /* already signed out */
  }
  closeStream();
  state.authed = false;
  state.user = null;
  state.exam = null;
  state.examId = null;
  render();
}

function accountCard() {
  const pw = h('input', { id: 'del-pw', type: 'password', autocomplete: 'current-password', 'aria-label': 'Confirm your password' });
  const msg = h('p', { class: 'msg error', role: 'alert' });
  return h('div', { class: 'card' },
    h('h2', { text: 'Account' }),
    h('p', { class: 'muted small', text: `${state.user ? state.user.name : ''} (${state.user ? state.user.email : ''})` }),
    state.showDelete
      ? h('div', {},
          h('p', { class: 'small', text: 'This permanently deletes your account, every exam and all student records. Enter your password to confirm.' }),
          pw,
          h('div', { class: 'row mt' },
            h('button', {
              class: 'btn danger small', type: 'button', text: 'Delete everything',
              onclick: async () => {
                try {
                  await api('POST', '/api/account/delete', { password: pw.value });
                  closeStream();
                  state.authed = false; state.user = null; state.exam = null; state.examId = null; state.showDelete = false;
                  render();
                } catch (err) {
                  msg.textContent = err.message;
                }
              }
            }),
            h('button', { class: 'btn small', type: 'button', text: 'Cancel', onclick: () => { state.showDelete = false; render(); } })
          ),
          msg)
      : h('button', { class: 'btn small', type: 'button', text: 'Delete my account…', onclick: () => { state.showDelete = true; render(); } })
  );
}

function sidebar() {
  const list = h('ul', { class: 'examlist' },
    state.exams.map((e) =>
      h('li', {},
        h('button', {
          type: 'button',
          'aria-current': e.id === state.examId ? 'true' : null,
          onclick: () => selectExam(e.id)
        },
          e.title,
          h('span', { class: 'meta', text: `${e.studentCount} student${e.studentCount === 1 ? '' : 's'}${e.open ? '' : ', joining closed'}` })
        )
      )
    )
  );
  return h('aside', { class: 'side' },
    h('div', { class: 'card' },
      h('h2', { text: 'Exams' }),
      h('button', {
        class: 'btn primary', type: 'button', text: 'New exam',
        onclick: () => { state.mode = 'new'; renderMain(); }
      }),
      state.exams.length ? list : h('p', { class: 'muted small', text: 'No exams yet. Create one to get a join code for your students.' })
    ),
    h('p', { class: 'muted small', text: `Records are deleted automatically ${state.retentionDays ? `${state.retentionDays} days after an exam’s last activity` : 'never (retention is turned off)'}. You can delete an exam at any time.` }),
    accountCard()
  );
}

function renderMain() {
  const main = refs.main;
  main.replaceChildren();
  if (state.mode === 'new' || state.mode === 'edit') return main.append(examForm());
  if (!state.exam) {
    return main.append(h('div', { class: 'card' },
      h('h1', { text: 'Welcome' }),
      h('p', { class: 'muted', text: 'Create an exam, give students the join code, and watch tab, window and page-visibility incidents arrive here as they happen. Only you can see the exams you create.' })
    ));
  }
  const e = state.exam;

  const copyBtn = h('button', {
    class: 'btn small', type: 'button', text: 'Copy code',
    onclick: async () => {
      try { await navigator.clipboard.writeText(e.code); copyBtn.textContent = 'Copied'; } catch { copyBtn.textContent = 'Press Ctrl+C on the code'; }
    }
  });
  let armed = false;
  const delBtn = h('button', {
    class: 'btn danger small', type: 'button', text: 'Delete exam and records',
    onclick: async () => {
      if (!armed) { armed = true; delBtn.textContent = 'Press again to delete'; delBtn.classList.add('armed'); setTimeout(() => { armed = false; delBtn.textContent = 'Delete exam and records'; delBtn.classList.remove('armed'); }, 5000); return; }
      await api('DELETE', `/api/exams/${e.id}`);
      closeStream(); state.examId = null; state.exam = null;
      await loadExams(); render();
    }
  });

  main.append(
    h('div', { class: 'card' },
      h('div', { class: 'examhead' },
        h('div', {},
          h('h1', { text: e.title }),
          h('p', { class: 'muted small', text: e.formUrl ? 'Authorized form is set for students who connect.' : 'No form link set. Students will use the form saved in their own extension.' })
        ),
        h('div', {}, h('span', { class: 'code', text: e.code }), ' ', copyBtn)
      ),
      h('div', { class: 'joininfo' },
        'Students: open NO CAP → ', h('b', { text: 'Settings' }), ' → ', h('b', { text: 'Instructor dashboard' }),
        '. Server address ', h('code', { text: location.origin }), ' and join code ', h('code', { text: e.code }), '.'
      ),
      h('div', { class: 'row mt' },
        h('button', { class: 'btn small', type: 'button', text: e.open ? 'Stop accepting students' : 'Accept students again', onclick: async () => { await api('PATCH', `/api/exams/${e.id}`, { open: !e.open }); await loadExam(); await loadExams(); render(); } }),
        h('button', { class: 'btn small', type: 'button', text: 'Edit exam settings', onclick: () => { state.mode = 'edit'; renderMain(); } }),
        h('a', { class: 'btn small', href: `/api/exams/${e.id}/export.csv`, text: 'Export CSV' }),
        delBtn
      )
    ),
    h('p', { class: 'notice', text: 'Reports are supporting evidence, not proof of cheating. “Not confirmed” means NO CAP saw a signal (for example, the browser window lost focus) but cannot tell what the student did. “Not reporting” can mean a closed laptop, lost network or a disabled extension.' }),
    (refs.chips = h('div', { class: 'chips' })),
    h('div', { class: 'filters' },
      h('input', { type: 'text', placeholder: 'Search students', 'aria-label': 'Search students', value: state.filter.q, oninput: (ev) => { state.filter.q = ev.target.value; renderRoster(); } }),
      checkbox('Flagged only', state.filter.flagged, (v) => { state.filter.flagged = v; renderRoster(); }),
      checkbox('With incidents', state.filter.incidents, (v) => { state.filter.incidents = v; renderRoster(); }),
      h('select', { 'aria-label': 'Sort', onchange: (ev) => { state.filter.sort = ev.target.value; renderRoster(); } },
        h('option', { value: 'attention', text: 'Needs attention first', selected: state.filter.sort === 'attention' }),
        h('option', { value: 'name', text: 'Name', selected: state.filter.sort === 'name' })
      ),
      checkbox('Beep on new incident', state.sound, (v) => { state.sound = v; if (v) beep(); })
    ),
    h('div', { class: 'tablewrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, ['Student', 'Connection', 'Exam status', 'Incidents', 'Latest incident', 'Review flag'].map((t) => h('th', { scope: 'col', text: t })))),
        (refs.tbody = h('tbody'))
      )
    ),
    h('div', { class: 'card mt' },
      h('h2', { text: 'Latest incidents' }),
      (refs.feed = h('ul', { class: 'feed' }))
    )
  );
  renderRoster();
}

function checkbox(label, checked, onchange) {
  return h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: checked ? true : null, onchange: (ev) => onchange(ev.target.checked) }),
    label
  );
}

function renderRoster() {
  if (!refs.tbody) return;
  const all = [...state.students.values()].map((s) => ({ s, v: view(s) }));
  const count = (fn) => all.filter(fn).length;
  const chips = [
    ['Joined', all.length, ''],
    ['In progress', count(({ v }) => v.sess && v.sess.status !== 'ended'), ''],
    ['With incidents', count(({ v }) => v.incidents.length > 0), ''],
    ['Flagged', count(({ v }) => v.sess && v.sess.flagged), 'alert'],
    ['Not reporting', count(({ v }) => v.conn.cls === 'stale'), 'warn']
  ];
  refs.chips.replaceChildren(...chips.map(([label, n, cls]) => h('div', { class: `chip ${n && cls ? cls : ''}` }, h('b', { text: String(n) }), h('span', { text: label }))));

  const rows = [];
  const now = Date.now();
  for (const { s, v } of visibleStudents()) {
    const fresh = (state.fresh.get(s.id) || 0) > now;
    const open = state.open.has(s.id);
    const toggle = () => { open ? state.open.delete(s.id) : state.open.add(s.id); renderRoster(); };
    rows.push(
      h('tr', { class: `student${fresh ? ' fresh' : ''}`, onclick: toggle },
        h('td', {},
          h('button', { class: 'namebtn', type: 'button', 'aria-expanded': open ? 'true' : 'false', text: s.name, onclick: (ev) => { ev.stopPropagation(); toggle(); } }),
          s.studentId ? h('div', { class: 'muted small', text: s.studentId }) : null
        ),
        h('td', {}, h('span', { class: `pill ${v.conn.cls}`, text: v.conn.label }),
          v.sess && v.conn.cls !== 'done' ? h('div', { class: 'muted small', text: `Last report ${new Date(s.lastSeenAt).toLocaleTimeString()}` }) : null),
        h('td', {}, h('span', { class: `pill ${v.status === 'Violation detected' ? 'violation' : ''}`, text: v.status })),
        h('td', { text: String(v.incidents.length) }),
        h('td', {}, v.last
          ? [incidentText(v.last), h('div', { class: 'muted small', text: new Date(v.last.ts).toLocaleTimeString() })]
          : h('span', { class: 'muted', text: 'None' })),
        h('td', {}, v.sess && v.sess.flagged ? h('span', { class: 'badge flag', text: 'Flagged for review' }) : h('span', { class: 'muted', text: '—' }))
      )
    );
    if (open) rows.push(h('tr', { class: 'detail' }, h('td', { colspan: '6' }, detail(s))));
  }
  if (!rows.length) rows.push(h('tr', {}, h('td', { colspan: '6', class: 'empty', text: all.length ? 'No students match the filters.' : 'No students have joined yet. Share the join code above.' })));
  refs.tbody.replaceChildren(...rows);

  // incident feed across all students
  const feed = [];
  for (const { s, v } of all) for (const inc of v.incidents) feed.push({ s, inc });
  feed.sort((a, b) => b.inc.ts - a.inc.ts);
  refs.feed.replaceChildren(
    ...(feed.length
      ? feed.slice(0, 12).map(({ s, inc }) => h('li', {},
          h('time', { text: new Date(inc.ts).toLocaleTimeString() }),
          h('b', { text: s.name }), ` — ${incidentText(inc)} `,
          h('span', { class: `badge ${isConfirmed(inc) ? 'detected' : 'unconfirmed'}`, text: isConfirmed(inc) ? 'Detected' : 'Not confirmed' })))
      : [h('li', { class: 'muted', text: 'No incidents yet.' })])
  );
}

function detail(s) {
  const box = h('div', {});
  if (!s.sessions.length) return box.appendChild(h('p', { class: 'muted', text: 'This student has joined but has not started the exam.' })) && box;
  for (const sess of s.sessions.slice(0, 3)) {
    const incs = [...sess.incidents].sort((a, b) => a.ts - b.ts);
    box.append(
      h('h3', { text: `Session ${sess.id}` }),
      h('p', { class: 'muted small', text: `Started ${formatDateTime(sess.startedAt)}${sess.endedAt ? `, ended ${formatDateTime(sess.endedAt)} (${formatDuration(sess.endedAt - sess.startedAt)})` : ', in progress'}. ${sess.interruptions ? `${sess.interruptions} monitoring interruption${sess.interruptions === 1 ? '' : 's'}. ` : ''}${sess.threshold ? `Review flag at ${sess.threshold} incidents.` : ''}` })
    );
    if (!incs.length) box.append(h('p', { class: 'muted', text: 'No incidents recorded.' }));
    incs.forEach((inc, i) => {
      const ok = isConfirmed(inc);
      box.append(h('div', { class: 'incident' },
        h('div', {}, h('b', { text: `${i + 1}. ${incidentText(inc)}` }), ' ', h('span', { class: `badge ${ok ? 'detected' : 'unconfirmed'}`, text: ok ? 'Detected' : 'Not confirmed' }), ' ', h('span', { class: 'muted small', text: formatDateTime(inc.ts) })),
        h('div', { class: 'muted small', text: evidenceNote(inc) }),
        inc.details.length ? h('ul', {}, inc.details.map((d) => h('li', { text: d }))) : null
      ));
    });
    if (sess.events.length) {
      box.append(h('ul', { class: 'events' }, [...sess.events].sort((a, b) => a.ts - b.ts).map((ev) => h('li', { text: `${new Date(ev.ts).toLocaleTimeString()}: ${ev.detail}` }))));
    }
  }
  return box;
}

// ---------------------------------------------------------------- exam form

function examForm() {
  const editing = state.mode === 'edit' && state.exam;
  const base = editing ? state.exam : { title: '', formUrl: '', policy: state.defaults };
  const p = base.policy;
  const f = {
    title: h('input', { id: 'f-title', type: 'text', maxlength: '120', value: base.title, required: true }),
    url: h('input', { id: 'f-url', type: 'url', placeholder: 'https://docs.google.com/forms/d/e/…/viewform', value: base.formUrl }),
    strict: h('input', { id: 'f-strict', type: 'checkbox', checked: p.strictMode ? true : null }),
    grace: h('input', { id: 'f-grace', type: 'number', min: '0', max: '30', value: String(p.graceSeconds) }),
    thr: h('input', { id: 'f-thr', type: 'number', min: '0', max: '99', value: String(p.violationThreshold) }),
    pro: h('textarea', { id: 'f-pro', spellcheck: 'false' }),
    allow: h('textarea', { id: 'f-allow', spellcheck: 'false' })
  };
  f.pro.value = p.prohibited.map((x) => `${x.domain}, ${x.category}`).join('\n');
  f.allow.value = p.allowedHosts.join('\n');
  const msg = h('p', { class: 'msg', role: 'status' });

  const form = h('form', { class: 'card' },
    h('h1', { text: editing ? 'Edit exam settings' : 'New exam' }),
    editing ? h('p', { class: 'muted small', text: 'Changes apply to students the next time they press Start Exam. Sessions already running keep the settings they started with.' }) : null,
    h('div', { class: 'field' }, h('label', { for: 'f-title', text: 'Title' }), f.title),
    h('div', { class: 'field' }, h('label', { for: 'f-url', text: 'Google Forms respond link (optional)' }), f.url,
      h('p', { class: 'help', text: 'The published link that contains /forms/d/e/ and ends in /viewform. When set, it is the only page students may use.' })),
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('label', { for: 'f-grace', text: 'Focus-loss grace period (seconds)' }), f.grace),
      h('div', { class: 'field' }, h('label', { for: 'f-thr', text: 'Flag for review after (incidents, 0 = off)' }), f.thr)
    ),
    h('div', { class: 'field' }, h('label', { class: 'check' }, f.strict, 'Strict Mode (best effort)'),
      h('p', { class: 'help', text: 'Tries to close new tabs and return the student to the exam. A determined student can still bypass it.' })),
    h('div', { class: 'field' }, h('label', { for: 'f-pro', text: 'Prohibited websites (one per line: domain, category)' }), f.pro),
    h('div', { class: 'field' }, h('label', { for: 'f-allow', text: 'Allowed exceptions (one domain per line)' }), f.allow,
      h('p', { class: 'help', text: 'Google sign-in is allowed by default so forms that require login keep working.' })),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'submit', text: editing ? 'Save changes' : 'Create exam' }),
      h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => { state.mode = null; renderMain(); } })
    ),
    msg
  );

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.className = 'msg';
    msg.textContent = '';
    const prohibited = f.pro.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [domain, ...rest] = l.split(',');
      return { domain: domain.trim(), category: rest.join(',').trim() || 'Prohibited' };
    });
    const body = {
      title: f.title.value,
      formUrl: f.url.value,
      policy: {
        strictMode: f.strict.checked,
        graceSeconds: f.grace.value,
        violationThreshold: f.thr.value,
        prohibited,
        allowedHosts: f.allow.value.split('\n').map((l) => l.trim()).filter(Boolean)
      }
    };
    try {
      if (editing) {
        await api('PATCH', `/api/exams/${state.exam.id}`, body);
        state.mode = null;
        await loadExam();
        await loadExams();
        render();
      } else {
        const res = await api('POST', '/api/exams', body);
        await loadExams();
        await selectExam(res.exam.id);
      }
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = err.message;
    }
  });
  return form;
}

// time-based statuses ("Not reporting") and highlight expiry need periodic repaint
setInterval(() => { if (state.authed && state.exam && !state.mode) renderRoster(); }, 5000);

boot();
