// Run with: node tests/static-check.mjs
// Verifies the manifest is well formed and every file it references exists.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const must = (rel, why) => assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel} (${why})`);

assert.equal(manifest.manifest_version, 3);
for (const k of ['name', 'version', 'description']) assert.ok(manifest[k], `manifest.${k} required`);

must(manifest.background.service_worker, 'service worker');
must(manifest.action.default_popup, 'popup');
must(manifest.options_ui.page, 'options page');
for (const cs of manifest.content_scripts) for (const f of cs.js) must(f, 'content script');
for (const p of Object.values({ ...manifest.icons, ...manifest.action.default_icon })) must(p, 'icon');

// Every local file referenced from our HTML pages must exist.
for (const page of ['popup.html', 'options.html', 'review.html']) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) must(m[1], `referenced by ${page}`);
}
// Every relative import must exist.
for (const f of fs.readdirSync(root).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/from\s+'(\.\/[^']+)'/g)) must(m[1].slice(2), `imported by ${f}`);
}

// ---- Hosted dashboard (Vercel) ----
const dash = path.join(root, 'dashboard');
const dmust = (rel) => assert.ok(fs.existsSync(path.join(dash, rel)), `missing dashboard/${rel}`);
for (const f of ['api/[...path].js', 'lib/app.js', 'lib/db.js', 'lib/auth.js', 'lib/sanitize.js', 'lib/shared.js', 'local.js',
  'public/index.html', 'public/app.js', 'public/style.css', 'public/shared.js', 'vercel.json', 'package.json', 'README.md']) dmust(f);

// shared.js lives in three places; they must never drift apart (run "npm run sync-shared" in dashboard/).
const source = fs.readFileSync(path.join(root, 'shared.js'), 'utf8');
for (const copy of ['lib/shared.js', 'public/shared.js']) {
  assert.equal(fs.readFileSync(path.join(dash, copy), 'utf8'), source, `dashboard/${copy} is out of date: run npm run sync-shared`);
}

const vercel = JSON.parse(fs.readFileSync(path.join(dash, 'vercel.json'), 'utf8'));
assert.equal(vercel.outputDirectory, 'public');
assert.ok(fs.existsSync(path.join(dash, vercel.outputDirectory, 'index.html')));
for (const c of vercel.crons || []) {
  assert.ok(fs.readFileSync(path.join(dash, 'lib/app.js'), 'utf8').includes(`'${c.path}'`), `cron ${c.path} has no route`);
}
const dpkg = JSON.parse(fs.readFileSync(path.join(dash, 'package.json'), 'utf8'));
assert.deepEqual(Object.keys(dpkg.dependencies), ['@neondatabase/serverless'], 'production dependencies should stay minimal');
assert.equal(dpkg.type, 'module');

// The page's own references must resolve to files served from public/.
const dashHtml = fs.readFileSync(path.join(dash, 'public/index.html'), 'utf8');
for (const m of dashHtml.matchAll(/(?:src|href)="\/([^"#:]+)"/g)) {
  assert.ok(fs.existsSync(path.join(dash, 'public', m[1])), `dashboard page references missing ${m[1]}`);
}
// CSP forbids inline styles/scripts and the client must never build markup from strings.
const dashApp = fs.readFileSync(path.join(dash, 'public/app.js'), 'utf8');
assert.ok(!/style:\s*['"]/.test(dashApp) && !/innerHTML/.test(dashApp), 'dashboard client must not use inline styles or innerHTML');
// Serverless code must not rely on memory or timers that disappear between requests.
const dapp = fs.readFileSync(path.join(dash, 'lib/app.js'), 'utf8');
assert.ok(!/setInterval|setTimeout\(/.test(dapp), 'lib/app.js must not use timers (serverless)');

// Least privilege: exactly these permissions, no host permissions.
assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'notifications', 'storage', 'tabs']);
assert.equal(manifest.host_permissions, undefined);
// Contacting an instructor dashboard is opt-in: host access is optional and requested per address at connect time.
assert.deepEqual([...manifest.optional_host_permissions].sort(), ['http://*/*', 'https://*/*']);

// No remote code, no eval, no browser storage APIs that bypass chrome.storage.
for (const f of fs.readdirSync(root).filter((x) => /\.(js|html)$/.test(x))) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  assert.ok(!/\beval\s*\(|new Function\(/.test(src), `${f} uses eval`);
  assert.ok(!/https?:\/\/[^'"\s]*\.js/.test(src.replace(/docs\.google\.com/g, '')), `${f} loads remote script`);
}
console.log('static checks passed');
