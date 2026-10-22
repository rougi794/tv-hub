// Deploys dist/ to a TV over adb.
//   node scripts/deploy.mjs [device] [root]
//   device: adb serial (required, e.g. 192.168.8.202:5555), root: web folder on the TV (default /sdcard/tv_hub)
// Page files are replaced; data files from seed/data are pushed only when missing on the TV,
// so the owner's meals, reminders, images and playlists are never overwritten.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const device = process.argv[2];
if (!device) { console.error('usage: node scripts/deploy.mjs <adb-serial, e.g. 192.168.8.202:5555> [root]   (find TVs: npm run find-tvs)'); process.exit(2); }
const root = process.argv[3] || '/sdcard/tv_hub';

// MSYS_NO_PATHCONV keeps Git Bash from rewriting /sdcard/... into a Windows path
const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
const adb = (...args) => execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8', env });

// Order matters (DECISIONS H-019): a page must never reference a script that is still being copied.
// 1) the new hashed bundles (new names, nothing uses them yet), 2) everything else, pages last,
// 3) remove the previous build's bundles. Before, assets/ was deleted first and a page could load a half-copied file.
adb('shell', 'mkdir', '-p', root + '/data', root + '/assets');
const dist = join(web, 'dist');
console.log('assets: ' + adb('push', join(dist, 'assets') + '/.', root + '/assets/').trim().split('\n').pop());
const top = readdirSync(dist, { withFileTypes: true });
const pages = top.filter((e) => e.isFile() && e.name.endsWith('.html')).map((e) => e.name);
for (const e of top) {
  if (e.name === 'assets' || pages.includes(e.name)) continue;
  adb('push', join(dist, e.name), root + '/');
}
for (const p of pages) adb('push', join(dist, p), root + '/' + p);
console.log('pages: ' + pages.join(', '));
const keep = new Set(readdirSync(join(dist, 'assets')));
const old = adb('shell', 'ls', root + '/assets').split(/\s+/).filter((f) => f && !keep.has(f));
if (old.length) adb('shell', 'rm', '-f', ...old.map((f) => root + '/assets/' + f));
console.log('removed ' + old.length + ' old bundle file(s)');

const present = new Set(adb('shell', 'ls', root + '/data').split(/\s+/).filter(Boolean));
// the kids interface has no reminders: no default reminders.json there (AUDIT-3 L5)
let mode = 'home';
try { mode = JSON.parse(adb('shell', 'cat', root + '_private/device.json')).mode || 'home'; } catch { /* new TV */ }
const homeOnly = new Set(['reminders.json']);
for (const f of readdirSync(join(web, 'seed', 'data'))) {
  if (present.has(f) || (mode === 'kids' && homeOnly.has(f))) continue;
  adb('push', join(web, 'seed', 'data', f), root + '/data/' + f);
  console.log('seeded data/' + f);
}
console.log('deployed to ' + device + ':' + root);
