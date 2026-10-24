// lib/sanitize.js — validation of everything that arrives from outside.
// Student reports are untrusted input: unknown fields are dropped and sizes are capped.

import { parseFormUrl, normalizeDomain, DEFAULT_SETTINGS, CATEGORY_META } from './shared.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CATEGORIES = new Set(Object.keys(CATEGORY_META));
const STATUSES = new Set(['in_progress', 'violation', 'ended']);

export const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const strOrNull = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const num = (v) => (Number.isFinite(v) ? v : null);
export const clamp = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !/^NC-\d{8}-[0-9A-F]{6}$/.test(raw.id)) return null;
  if (!STATUSES.has(raw.status)) return null;
  const startedAt = num(raw.startedAt);
  if (startedAt == null) return null;

  const incidents = (Array.isArray(raw.incidents) ? raw.incidents : [])
    .slice(0, 500)
    .map((i) => {
      if (!i || typeof i !== 'object' || !CATEGORIES.has(i.category)) return null;
      const ts = num(i.ts);
      if (ts == null) return null;
      return {
        id: str(i.id, 60),
        ts,
        category: i.category,
        warning: str(i.warning, 200),
        domain: strOrNull(i.domain, 120),
        domainCategory: strOrNull(i.domainCategory, 60),
        details: (Array.isArray(i.details) ? i.details : []).slice(0, 10).map((d) => str(d, 300)),
        signals: (Array.isArray(i.signals) ? i.signals : [])
          .slice(0, 20)
          .filter((s) => s && CATEGORIES.has(s.type) && num(s.ts) != null)
          .map((s) => ({ type: s.type, ts: s.ts, endedTs: num(s.endedTs) })),
        ackTs: num(i.ackTs)
      };
    })
    .filter(Boolean);

  const events = (Array.isArray(raw.events) ? raw.events : [])
    .slice(0, 500)
    .filter((e) => e && num(e.ts) != null)
    .map((e) => ({ ts: e.ts, type: str(e.type, 30), detail: str(e.detail, 400) }));

  return {
    id: raw.id,
    status: raw.status,
    startedAt,
    endedAt: num(raw.endedAt),
    lastHeartbeat: num(raw.lastHeartbeat),
    flagged: !!raw.flagged,
    flaggedAt: num(raw.flaggedAt),
    threshold: clamp(raw.threshold, 0, 99, 0),
    interruptions: clamp(raw.interruptions, 0, 999, 0),
    ignoredFocusBlips: clamp(raw.ignoredFocusBlips, 0, 99999, 0),
    formResponseSeen: !!raw.formResponseSeen,
    incidents,
    events
  };
}

export function sanitizePolicy(p, base = DEFAULT_SETTINGS) {
  const src = p && typeof p === 'object' ? p : {};
  const listOf = (v, fallback) => (Array.isArray(v) ? v : fallback);

  const prohibited = [];
  const seen = new Set();
  for (const item of listOf(src.prohibited, base.prohibited)) {
    const domain = normalizeDomain(item && item.domain);
    if (!domain) throw new HttpError(400, `“${item && item.domain}” is not a valid prohibited domain.`);
    if (seen.has(domain)) continue;
    seen.add(domain);
    prohibited.push({ domain, category: str(item.category, 40) || 'Prohibited' });
  }
  const allowedHosts = [];
  for (const raw of listOf(src.allowedHosts, base.allowedHosts)) {
    const host = normalizeDomain(raw);
    if (!host) throw new HttpError(400, `“${raw}” is not a valid allowed domain.`);
    if (!allowedHosts.includes(host)) allowedHosts.push(host);
  }
  return {
    strictMode: !!(src.strictMode ?? base.strictMode),
    graceSeconds: clamp(src.graceSeconds ?? base.graceSeconds, 0, 30, base.graceSeconds),
    violationThreshold: clamp(src.violationThreshold ?? base.violationThreshold, 0, 99, base.violationThreshold),
    prohibited,
    allowedHosts
  };
}

export function cleanFormUrl(v) {
  if (v == null || String(v).trim() === '') return '';
  const parsed = parseFormUrl(v);
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  return parsed.canonical;
}

export function cleanTitle(v) {
  const t = str(v, 120).trim();
  if (!t) throw new HttpError(400, 'Give the exam a title.');
  return t;
}
