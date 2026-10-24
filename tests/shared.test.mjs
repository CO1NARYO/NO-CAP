// Run with: node tests/shared.test.mjs   (no dependencies)
import assert from 'node:assert/strict';
import {
  parseFormUrl, isFormMatch, classifyUrl, normalizeDomain,
  isConfirmed, csvCell, formatDuration, DEFAULT_SETTINGS, CATEGORY_META
} from '../shared.js';

const ID = '1FAIpQLSeAbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const FORM = `https://docs.google.com/forms/d/e/${ID}/viewform`;
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

t('parse: canonical link drops query and fragment', () => {
  const r = parseFormUrl(`${FORM}?usp=sf_link#responseId=1`);
  assert.ok(r.ok); assert.equal(r.canonical, FORM); assert.equal(r.id, ID);
});
t('parse: formResponse link is canonicalised to viewform', () => {
  assert.equal(parseFormUrl(`https://docs.google.com/forms/d/e/${ID}/formResponse`).canonical, FORM);
});
t('parse: workspace prefix is preserved', () => {
  assert.equal(parseFormUrl(`https://docs.google.com/a/school.edu/forms/d/e/${ID}/viewform`).canonical,
    `https://docs.google.com/a/school.edu/forms/d/e/${ID}/viewform`);
});
t('parse: rejects empty, junk, http, other hosts, docs pages, editor and short links', () => {
  for (const bad of ['', 'hello', `http://docs.google.com/forms/d/e/${ID}/viewform`,
    `https://example.com/forms/d/e/${ID}/viewform`,
    'https://docs.google.com/document/d/abc/edit',
    `https://docs.google.com/forms/d/${ID}/edit`,
    'https://forms.gle/abc123',
    `https://docs.google.com/forms/d/e/${ID}/viewscore`]) {
    assert.equal(parseFormUrl(bad).ok, false, bad);
  }
});
t('match: same form with query/hash and other page types', () => {
  const f = { id: ID };
  assert.ok(isFormMatch(`${FORM}?pageId=3#x`, f));
  assert.ok(isFormMatch(`https://docs.google.com/forms/d/e/${ID}/formResponse`, f));
  assert.ok(isFormMatch(`https://docs.google.com/forms/d/e/${ID}/viewscore?x=1`, f));
});
t('match: different form, other Google Docs pages and lookalike hosts are not matched', () => {
  const f = { id: ID };
  assert.equal(isFormMatch(`https://docs.google.com/forms/d/e/OTHERFORMID1234/viewform`, f), false);
  assert.equal(isFormMatch('https://docs.google.com/document/d/abc/edit', f), false);
  assert.equal(isFormMatch(`https://docs.google.com.evil.com/forms/d/e/${ID}/viewform`, f), false);
});

const cfg = { form: { id: ID }, prohibited: DEFAULT_SETTINGS.prohibited, allowedHosts: DEFAULT_SETTINGS.allowedHosts };
t('classify: exam form is authorized', () => assert.ok(classifyUrl(FORM, cfg).authorized));
t('classify: allowed exception (Google sign-in) is authorized, other Google hosts are not', () => {
  assert.ok(classifyUrl('https://accounts.google.com/signin', cfg).authorized);
  assert.equal(classifyUrl('https://docs.google.com/document/d/abc/edit', cfg).authorized, false);
  assert.equal(classifyUrl('https://mail.google.com/', cfg).authorized, false);
});
t('classify: ChatGPT and subdomains are prohibited, with a category and no path', () => {
  const r = classifyUrl('https://chatgpt.com/c/secret-conversation-id?q=hi', cfg);
  assert.equal(r.category, 'prohibited_site'); assert.equal(r.domain, 'chatgpt.com');
  assert.equal(r.domainCategory, 'AI assistant');
  assert.ok(!JSON.stringify(r).includes('secret'));
  assert.equal(classifyUrl('https://www.chatgpt.com/', cfg).category, 'prohibited_site');
});
t('classify: lookalike domain is not mistaken for a prohibited one', () => {
  assert.equal(classifyUrl('https://notchatgpt.com/', cfg).category, 'unauthorized_url');
});
t('classify: file URLs and PDFs', () => {
  assert.equal(classifyUrl('file:///C:/Users/me/notes.pdf', cfg).category, 'local_or_pdf');
  const pdf = classifyUrl('https://example.edu/notes.PDF?download=1', cfg);
  assert.equal(pdf.category, 'local_or_pdf'); assert.equal(pdf.domainCategory, 'PDF document');
});
t('classify: browser pages and unreadable URLs', () => {
  assert.equal(classifyUrl('chrome://newtab/', cfg).domain, 'chrome://newtab');
  const u = classifyUrl('', cfg);
  assert.equal(u.authorized, false); assert.equal(u.readable, false);
});
t('normalizeDomain', () => {
  assert.equal(normalizeDomain('https://Example.com/path?x=1'), 'example.com');
  assert.equal(normalizeDomain('sub.example.co.uk:8080'), 'sub.example.co.uk');
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(normalizeDomain('localhost'), null);
});
t('isConfirmed: focus/visibility alone are unconfirmed; a tab switch is detected', () => {
  assert.equal(isConfirmed({ signals: [{ type: 'window_focus_lost' }, { type: 'visibility_hidden' }] }), false);
  assert.equal(isConfirmed({ signals: [{ type: 'visibility_hidden' }, { type: 'tab_switch' }] }), true);
});
t('category priorities: prohibited site outranks tab switch outranks focus loss', () => {
  const p = (c) => CATEGORY_META[c].priority;
  assert.ok(p('prohibited_site') > p('unauthorized_url'));
  assert.ok(p('tab_switch') > p('visibility_hidden'));
  assert.ok(p('visibility_hidden') > p('window_focus_lost'));
});
t('csvCell escapes quotes and neutralises formulas', () => {
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
});
t('formatDuration', () => assert.equal(formatDuration(3723000), '01:02:03'));

console.log(`\n${n} checks passed`);
