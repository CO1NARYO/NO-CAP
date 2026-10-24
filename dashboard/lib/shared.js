// shared.js
// Helpers shared by background.js, popup.js, options.js and review.js.
// Everything here is free of chrome.* calls so it can be unit-tested in Node.

export const STATUS_LABEL = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  violation: 'Violation Detected',
  ended: 'Exam Ended'
};

// Events that arrive within this window are treated as one incident.
// (Switching tabs fires a tab event, a visibility event and often a URL event at once.)
export const MERGE_MS = 2500;

// Higher priority wins when several signals describe the same incident.
export const CATEGORY_META = {
  prohibited_site: {
    label: 'Prohibited website',
    priority: 70,
    warning: 'Warning: An unauthorized webpage was detected.'
  },
  local_or_pdf: {
    label: 'Local file or PDF tab',
    priority: 60,
    warning: 'Warning: An unauthorized webpage was detected.'
  },
  exam_tab_closed: {
    label: 'Exam tab closed',
    priority: 55,
    warning: 'Warning: The examination tab was closed. Please reopen the authorized exam page.'
  },
  unauthorized_url: {
    label: 'Unauthorized webpage',
    priority: 50,
    warning: 'Warning: An unauthorized webpage was detected.'
  },
  new_tab: {
    label: 'New tab opened',
    priority: 52, // outranks a plain unauthorized page so a blank new tab keeps its own label
    warning: 'Warning: Opening new tabs during an examination is prohibited.'
  },
  tab_switch: {
    label: 'Switched to another tab',
    priority: 30,
    warning: 'Warning: Switching tabs during an examination is prohibited.'
  },
  visibility_hidden: {
    label: 'Exam page hidden',
    priority: 20,
    warning: 'Warning: The examination page was hidden.'
  },
  window_focus_lost: {
    label: 'Window lost focus',
    priority: 10,
    warning: 'Warning: The examination window lost focus.'
  }
};

// These two signals only say "the student left"; they cannot say where to.
export const UNCONFIRMED_SIGNALS = new Set(['visibility_hidden', 'window_focus_lost']);

export const DEFAULT_SETTINGS = {
  examUrl: '',
  strictMode: false,
  graceSeconds: 3,
  violationThreshold: 3,
  prohibited: [
    { domain: 'chatgpt.com', category: 'AI assistant' },
    { domain: 'chat.openai.com', category: 'AI assistant' },
    { domain: 'gemini.google.com', category: 'AI assistant' },
    { domain: 'claude.ai', category: 'AI assistant' },
    { domain: 'copilot.microsoft.com', category: 'AI assistant' },
    { domain: 'perplexity.ai', category: 'AI assistant' }
  ],
  // Explicit exceptions. Google sign-in is allowed so forms that require login keep working.
  allowedHosts: ['accounts.google.com']
};

// ---------------------------------------------------------------------------
// Google Forms URL handling
// ---------------------------------------------------------------------------

// Optional /a/<workspace-domain> prefix, then /forms/d/e/<published id>/<page>
const FORM_PATH = /^(\/a\/[^/]+)?\/forms\/d\/e\/([A-Za-z0-9_-]{10,})\/(viewform|formResponse|viewscore)\/?$/;

/** Validate a link the user typed or captured and return its canonical form. */
export function parseFormUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter the Google Forms link first.' };

  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'That does not look like a web address.' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'Use a link that starts with https://.' };
  if (u.hostname === 'forms.gle') {
    return {
      ok: false,
      error: 'Short forms.gle links cannot be matched. Open the link in a tab, then press “Use current tab”.'
    };
  }
  if (u.hostname !== 'docs.google.com' || !/\/forms\//.test(u.pathname)) {
    return { ok: false, error: 'Only Google Forms links on docs.google.com/forms are supported.' };
  }

  const m = FORM_PATH.exec(u.pathname);
  if (!m) {
    if (/\/forms\/d\/[^/]+\/(edit|preview)/.test(u.pathname)) {
      return { ok: false, error: 'That is an editor link. Use the respond link that ends in /viewform.' };
    }
    return {
      ok: false,
      error: 'Use the published respond link (contains /forms/d/e/ and ends in /viewform). Open the form, then press “Use current tab”.'
    };
  }
  const [, prefix = '', id, page] = m;
  if (page === 'viewscore') {
    return { ok: false, error: 'Use the form’s respond link (…/viewform), not a score page.' };
  }
  // Query strings and fragments are deliberately dropped.
  return { ok: true, id, prefix, canonical: `https://docs.google.com${prefix}/forms/d/e/${id}/viewform` };
}

/** True when urlStr is a page of exactly this form (viewform, formResponse or viewscore). */
export function isFormMatch(urlStr, form) {
  if (!urlStr || !form) return false;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') return false;
    const m = FORM_PATH.exec(u.pathname);
    return !!m && m[2] === form.id;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// URL classification
// ---------------------------------------------------------------------------

export function hostMatches(host, domain) {
  const d = String(domain || '').toLowerCase();
  return !!d && (host === d || host.endsWith('.' + d));
}

/**
 * Decide whether a tab URL is allowed during an exam.
 * cfg = { form:{id}, prohibited:[{domain,category}], allowedHosts:[] }
 * Returns only domain-level information; paths and query strings are never returned.
 */
export function classifyUrl(urlStr, cfg) {
  const unreadable = {
    authorized: false,
    category: 'unauthorized_url',
    domain: null,
    domainCategory: null,
    readable: false
  };
  if (!urlStr) return unreadable;

  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return unreadable;
  }

  if (u.protocol === 'file:') {
    return {
      authorized: false,
      category: 'local_or_pdf',
      domain: '(local file)',
      domainCategory: 'Local file',
      readable: true
    };
  }

  const host = u.hostname.toLowerCase();
  const isWeb = u.protocol === 'http:' || u.protocol === 'https:';
  const domain = isWeb ? host : host ? `${u.protocol}//${host}` : `${u.protocol}${u.pathname}`;

  for (const p of cfg.prohibited || []) {
    if (hostMatches(host, p.domain)) {
      return {
        authorized: false,
        category: 'prohibited_site',
        domain: host,
        domainCategory: p.category || 'Prohibited',
        readable: true
      };
    }
  }
  if (cfg.form && isFormMatch(urlStr, cfg.form)) {
    return { authorized: true, category: null, domain: host, domainCategory: 'Exam form', readable: true };
  }
  for (const h of cfg.allowedHosts || []) {
    if (hostMatches(host, h)) {
      return { authorized: true, category: null, domain: host, domainCategory: 'Allowed exception', readable: true };
    }
  }
  if (isWeb && u.pathname.toLowerCase().endsWith('.pdf')) {
    return { authorized: false, category: 'local_or_pdf', domain: host, domainCategory: 'PDF document', readable: true };
  }
  return { authorized: false, category: 'unauthorized_url', domain, domainCategory: null, readable: true };
}

/**
 * Validate the instructor dashboard address a student types.
 * https is required, except plain http for localhost and private school-LAN addresses.
 * Only the origin is kept; any path is dropped.
 */
export function validateServerUrl(input) {
  let u;
  try {
    u = new URL(String(input ?? '').trim());
  } catch {
    return { ok: false, error: 'Enter the dashboard address your instructor gave you, for example https://exams.myschool.edu.' };
  }
  const host = u.hostname;
  const privateHost =
    host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
    /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (u.protocol === 'https:' || (u.protocol === 'http:' && privateHost)) {
    return { ok: true, origin: u.origin, pattern: `${u.origin}/*` };
  }
  return { ok: false, error: 'Use an https:// address. Plain http:// is allowed only for localhost and school network addresses.' };
}

/** Reduce user input to a bare hostname, or return null if it is not a plausible domain. */
export function normalizeDomain(input) {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// Incident helpers
// ---------------------------------------------------------------------------

/** An incident is "detected" when at least one signal observed a concrete action. */
export function isConfirmed(incident) {
  return (incident.signals || []).some((s) => !UNCONFIRMED_SIGNALS.has(s.type));
}

export function evidenceNote(incident) {
  if (!isConfirmed(incident)) {
    return 'Not confirmed: the extension only observed that the exam page lost focus or visibility. It cannot tell what the student did or which application was used.';
  }
  if (incident.category === 'exam_tab_closed') {
    return 'Detected: the exam tab was closed. No destination applies.';
  }
  if (!incident.domain) {
    return 'Detected, but the address of the destination page could not be read.';
  }
  return 'Detected: the destination domain was read from the browser tab.';
}

// ---------------------------------------------------------------------------
// Formatting and small utilities
// ---------------------------------------------------------------------------

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function formatDateTime(ts) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

/** Escape one CSV cell and neutralise spreadsheet formula injection. */
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Tiny DOM builder used by the extension pages. Never uses innerHTML. */
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
