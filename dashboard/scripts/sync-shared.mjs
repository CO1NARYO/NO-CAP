// Copies the extension's shared.js (the single source of truth) into the two places the
// dashboard needs it: lib/ for the serverless functions and public/ for the browser.
// Run after editing ../shared.js:  npm run sync-shared
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, '..', '..', 'shared.js');
for (const target of ['lib/shared.js', 'public/shared.js']) {
  fs.copyFileSync(source, path.join(here, '..', target));
  console.log(`copied shared.js -> ${target}`);
}
