// Finds the TV Hub TVs on the local network (e.g. after the router gave them new addresses).
//   node scripts/find-tvs.mjs [192.168.8]        (npm run find-tvs -- 192.168.8)
// Without an argument it scans the /24 network of each IPv4 address of this PC.
// A TV is recognised by its phone admin server (port 8080, /api/admin/status); port 5555 shows whether ADB answers.
import net from 'node:net';
import os from 'node:os';

const prefixes = process.argv[2]
  ? [process.argv[2].replace(/\.$/, '')]
  : [...new Set(Object.values(os.networkInterfaces()).flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => a.address.split('.').slice(0, 3).join('.')))];

const portOpen = (host, port, ms = 800) => new Promise((res) => {
  const s = net.connect({ host, port });
  const done = (v) => { s.destroy(); res(v); };
  s.setTimeout(ms, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

async function probe(ip) {
  if (!(await portOpen(ip, 8080))) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`http://${ip}:8080/api/admin/status`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (!('set' in j)) return null;                   // some other device answering on 8080
    return { ip, adb: await portOpen(ip, 5555) };
  } catch {
    return null;
  }
}

for (const p of prefixes) {
  console.log(`scanning ${p}.1-254 ...`);
  const ips = Array.from({ length: 254 }, (_, i) => `${p}.${i + 1}`);
  const found = [];
  for (let i = 0; i < ips.length; i += 64) {              // 64 at a time
    found.push(...(await Promise.all(ips.slice(i, i + 64).map(probe))).filter(Boolean));
  }
  if (!found.length) console.log('  no TV Hub found (TVs off or asleep?)');
  for (const f of found) {
    console.log(`  TV Hub at ${f.ip}  -> phone admin: http://${f.ip}:8080/   ADB: ${f.adb ? `adb connect ${f.ip}:5555` : 'off'}`);
  }
}
