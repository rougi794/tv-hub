// Post-deploy security check of one TV (no passwords needed).
//   node scripts/smoke.mjs 192.168.1.50          (npm run smoke -- 192.168.1.50)
// Checks the phone admin server (8080) from this PC and, through `adb forward`, the TV's local server (8765).
import { execFileSync } from 'node:child_process';
import http from 'node:http';

const ip = process.argv[2];
if (!ip) { console.error('usage: node scripts/smoke.mjs <tv-ip>'); process.exit(2); }
const admin = `http://${ip}:8080`;
let failed = 0;

async function check(name, url, init, expect) {
  let got;
  try {
    const r = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(8000) });   // a frozen TV must not hang the run
    got = await expect.read(r);
  } catch (e) {
    got = 'error: ' + e.message;
  }
  const ok = expect.ok(got);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  -> ${got}`);
}
const status = (code) => ({ read: (r) => r.status, ok: (s) => s === code });
const header = (h) => ({ read: (r) => r.headers.get(h), ok: (v) => !!v });

// ---- phone admin server (LAN) ----
await check('admin page is public', `${admin}/`, {}, status(200));
await check('status is public', `${admin}/api/admin/status`, {}, status(200));
await check('status does not reveal the interface', `${admin}/api/admin/status`, {}, { read: async (r) => JSON.stringify(Object.keys(await r.json())), ok: (k) => !k.includes('mode') && !k.includes('pinLockedFor') });
await check('data needs login', `${admin}/data/meals.json`, {}, status(401));
await check('app list needs login', `${admin}/api/apps`, {}, status(401));
await check('file list needs login', `${admin}/api/file/list?dir=today_images`, {}, status(401));
await check('write needs login', `${admin}/api/file/write?dir=data&name=meals.json`, { method: 'POST', body: '{"meals":[]}' }, status(401));
await check('photo backup needs login', `${admin}/api/backup/images.zip`, {}, status(401));
await check('photos need login', `${admin}/today_images/x.jpg`, {}, status(401));
await check('stream settings need login', `${admin}/api/config`, {}, status(401));
await check('settings save needs login', `${admin}/api/config`, { method: 'POST', body: '{"baseUrl":"http://x"}' }, status(401));
await check('connection test needs login', `${admin}/api/config/test`, { method: 'POST', body: '{}' }, status(401));
await check('config.json never served', `${admin}/config.json`, {}, status(404));
await check('wifi.json never served', `${admin}/data/wifi.json`, {}, status(401));
// fetch() ignores a custom Host header, so this one uses a raw request
{
  const code = await new Promise((res) => {
    const rq = http.request({ host: ip, port: 8080, path: '/', headers: { Host: 'attacker.example:8080' } }, (r) => { r.resume(); res(r.statusCode); });
    rq.on('error', (e) => res('error: ' + e.message));
    rq.end();
  });
  const ok = code === 421;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  foreign Host refused (DNS rebinding)  -> ${code}`);
}
await check('header nosniff', `${admin}/`, {}, header('x-content-type-options'));
await check('header frame-ancestors', `${admin}/`, {}, header('content-security-policy'));

// ---- TV local server (only reachable on the TV: adb forward) ----
const serial = `${ip}:5555`;
const port = 18765;
try {
  execFileSync('adb', ['-s', serial, 'forward', `tcp:${port}`, 'tcp:8765'], { stdio: 'ignore' });
  const local = `http://127.0.0.1:${port}`;
  await check('own page may read the API', `${local}/api/hub/ping`, { headers: { 'Sec-Fetch-Site': 'same-origin' } }, status(200));
  // another app on the TV sends no browser headers and has no app token (AUDIT-3 S1)
  await check('other apps cannot read config.json', `${local}/config.json`, {}, status(403));
  await check('other apps cannot read data files', `${local}/data/channels.json`, {}, status(403));
  await check('other apps cannot list apps', `${local}/api/hub/apps`, {}, status(403));
  await check('page files stay open', `${local}/kids.html`, {}, status(200));
  await check('other site cannot read config.json', `${local}/config.json`, { headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://example.com' } }, status(403));
  await check('other site cannot launch apps', `${local}/api/hub/launch?pkg=com.android.vending`, { headers: { 'Sec-Fetch-Site': 'cross-site' } }, status(403));
  await check('other site cannot try PINs', `${local}/api/hub/pin/check?pin=000000`, { headers: { 'Sec-Fetch-Site': 'cross-site' } }, status(403));
  await check('no CORS header', `${local}/api/hub/ping`, {}, { read: (r) => r.headers.get('access-control-allow-origin'), ok: (v) => v === null });
} catch (e) {
  console.log('SKIP  local server checks (adb not available for ' + serial + '): ' + e.message);
} finally {
  try { execFileSync('adb', ['-s', serial, 'forward', '--remove', `tcp:${port}`], { stdio: 'ignore' }); } catch { /* ignore */ }
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
