// Screensaver page for HubDream (Android "dream"): home = clock, dates, prayer times and the time to the next one;
// kids = clock, dates and the photo of the day. Nothing to click; any remote key ends the screensaver.
import './saver.css';
import { getMode } from '../shared/hub';

interface Cfg { userSettings?: { location?: { city?: string; country?: string; timeZone?: string }; prayerMethod?: number } }
type PrayerKey = 'Fajr' | 'Dhuhr' | 'Asr' | 'Maghrib' | 'Isha';
type Timings = Record<PrayerKey, string>;

const PRAYERS: [PrayerKey, string][] = [['Fajr', 'الفجر'], ['Dhuhr', 'الظهر'], ['Asr', 'العصر'], ['Maghrib', 'المغرب'], ['Isha', 'العشاء']];
const PRAYER_CACHE = 'saver_prayers';
const $ = (id: string) => document.getElementById(id) as HTMLElement;
let timeZone: string | undefined;
let timings: Timings | null = null;

const localDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone });   // YYYY-MM-DD

function tick(): void {
  const now = new Date();
  const t = now.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone });
  const m = /^(\d\d:\d\d):(\d\d)\s?(AM|PM)$/i.exec(t);
  const time = $('time');
  if (m) {
    // HH:MM large, :SS smaller (admin request 2026-10-23), then ص / م
    const sec = document.createElement('span');
    sec.className = 'sec';
    sec.textContent = ':' + m[2];
    const small = document.createElement('small');
    small.textContent = m[3].toUpperCase() === 'AM' ? 'ص' : 'م';
    time.replaceChildren(document.createTextNode(m[1]), sec, small);
  } else {
    time.textContent = t;
  }
  $('greg').textContent = now.toLocaleDateString('ar-SA', { weekday: 'long', day: 'numeric', month: 'long', timeZone });
  $('hijri').textContent = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(now);
  showNext(now);
}

/** Prayer times of today (aladhan.com, same source as the dashboard), cached for the day. */
async function loadPrayers(cfg: Cfg): Promise<void> {
  const loc = cfg.userSettings?.location;
  if (!loc?.city) return;
  try {
    const c = JSON.parse(localStorage.getItem(PRAYER_CACHE) || 'null') as { date?: string; t?: Timings } | null;
    if (c?.date === localDate() && c.t) { timings = c.t; renderPrayers(); return; }
  } catch { /* storage unavailable */ }
  try {
    const url = `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(loc.city)}`
      + `&country=${encodeURIComponent(loc.country || '')}&method=${cfg.userSettings?.prayerMethod ?? 4}`;
    const j = await (await fetch(url, { cache: 'no-store' })).json() as { data?: { timings?: Timings } };
    if (!j.data?.timings) return;
    timings = j.data.timings;
    try { localStorage.setItem(PRAYER_CACHE, JSON.stringify({ date: localDate(), t: timings })); } catch { /* ignore */ }
    renderPrayers();
  } catch { /* offline: clock only */ }
}

const at = (hhmm: string, dayOffset = 0): Date => {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d;
};

function renderPrayers(): void {
  const t = timings;
  if (!t) return;
  $('prayers').replaceChildren(...PRAYERS.map(([k, name]) => {
    const d = document.createElement('div');
    d.className = 'p';
    d.dataset.k = k;
    const b = document.createElement('b');
    b.textContent = name;
    const s = document.createElement('span');
    s.textContent = t[k].slice(0, 5);
    d.append(b, s);
    return d;
  }));
  $('prayers').hidden = false;
  showNext(new Date());
}

function showNext(now: Date): void {
  const t = timings;
  if (!t) return;
  const found = PRAYERS.find(([k]) => at(t[k]) > now);
  const next = found || PRAYERS[0];
  const when = found ? at(t[found[0]]) : at(t.Fajr, 1);
  document.querySelectorAll<HTMLElement>('.p').forEach((p) => p.classList.toggle('next', p.dataset.k === next[0]));
  const mins = Math.max(0, Math.round((when.getTime() - now.getTime()) / 60000));
  const h = Math.floor(mins / 60), m = mins % 60;
  const left = h ? hours(h) + (m ? ' و ' + minutes(m) : '') : minutes(m);
  $('next').textContent = `${next[1]} بعد ${left}`;
  $('next').hidden = false;
}

// Arabic counted nouns: 1 ساعة، ساعتين، 3–10 ساعات، 11+ ساعة (same for minutes)
const counted = (n: number, one: string, two: string, few: string): string =>
  n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${one}`;
const hours = (n: number) => counted(n, 'ساعة', 'ساعتين', 'ساعات');
const minutes = (n: number) => (n === 0 ? 'أقل من دقيقة' : counted(n, 'دقيقة', 'دقيقتين', 'دقائق'));

/** Kids: the same photo the kids page shows today (shared storage), else the first one. */
async function loadPhoto(): Promise<void> {
  try {
    const j = await (await fetch('data/images.json', { cache: 'no-store' })).json() as { images?: string[] };
    const imgs = j.images || [];
    if (!imgs.length) return;
    let name = imgs[0];
    try {
      const st = JSON.parse(localStorage.getItem('kids_photo') || '{}') as { value?: string };
      if (st.value && imgs.includes(st.value)) name = st.value;
    } catch { /* ignore */ }
    const p = $('photo') as HTMLImageElement;
    p.onload = () => { p.hidden = false; };
    p.src = 'today_images/' + encodeURIComponent(name);
  } catch { /* no photo */ }
}

/** Burn-in protection: every minute the whole block fades and moves to another spot near the centre. */
function drift(): void {
  const box = $('box');
  box.classList.add('fade');
  setTimeout(() => {
    const x = Math.round((Math.random() - 0.5) * window.innerWidth * 0.3);
    const y = Math.round((Math.random() - 0.5) * window.innerHeight * 0.25);
    box.style.transform = `translate(${x}px, ${y}px)`;
    box.classList.remove('fade');
  }, 1300);
}

async function start(): Promise<void> {
  const cfg = await fetch('config.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({})) as Cfg;
  timeZone = cfg.userSettings?.location?.timeZone || undefined;
  tick();
  setInterval(tick, 1000);                       // every second: the seconds are shown
  const mode = await getMode().catch(() => 'home');
  if (mode === 'kids') {
    loadPhoto();
  } else {
    loadPrayers(cfg);
    setInterval(() => { if (!localStorage.getItem(PRAYER_CACHE)?.includes(localDate())) loadPrayers(cfg); }, 30 * 60_000);
  }
  setInterval(drift, 60_000);
}

if (new URLSearchParams(location.search).has('dream')) document.documentElement.classList.add('dream');   // dimmed
start();
