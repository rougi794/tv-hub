// TV channels: hls.js, a single provider connection at a time (spec 7.4, DECISIONS D-006/D-007).
import Hls from 'hls.js';
import { getJson } from '../shared/hub';
import { CFG, hidePlayerMsg, loadCfg, onPlayerStop, openPlayer, player, showPlayerMsg, showTitle } from './player';
import { allowed, lockMessage } from './timegate';
import { $, makeItem, renderKeepingFocus, toast } from './ui';

// `url`: a direct stream link (free channel, no account); otherwise the channel number at the provider
interface Channel { id: string; name: string; icon?: string; url?: string }

const DEFAULT_CHANNELS = ['سبيس تون', 'بسمة', 'روضة', 'أطفال المجد'];
let channels: Channel[] = [];
let chanIndex = 0, hls: Hls | null = null, chanGen = 0, lastStopAt = 0;

// ---- provider servers (failover) ----
// config.json: "baseUrl" (main server) and optional "baseUrls" (backup addresses of the SAME provider: same account,
// same channel ids). A server that fails, does not answer within ANSWER_TIMEOUT_MS, or answers but shows no picture
// within PICTURE_TIMEOUT_MS (a slow but working server gets this longer time) is left for the next one, with
// the single connection closed first. The server that worked is remembered for REMEMBER_MS; after that the main
// server is tried first again.
const SERVER_KEY = 'chan_server';
const ANSWER_TIMEOUT_MS = 15000;
const PICTURE_TIMEOUT_MS = 30000;
const REMEMBER_MS = 30 * 60 * 1000;

function servers(): string[] {
  const s = CFG.stream;
  const all = [s.baseUrl, ...(Array.isArray(s.baseUrls) ? s.baseUrls : [])]
    .filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u.trim()))
    .map((u) => u.trim().replace(/\/+$/, ''));
  return [...new Set(all)];
}

/** Index to start with: the server that worked last (if recent and still listed), else the main one. */
function firstServer(list: string[]): number {
  try {
    const m = JSON.parse(localStorage.getItem(SERVER_KEY) || 'null') as { base?: string; at?: number } | null;
    if (m && m.base && Date.now() - (m.at || 0) < REMEMBER_MS) return Math.max(0, list.indexOf(m.base));
  } catch { /* storage unavailable */ }
  return 0;
}

function rememberServer(list: string[], i: number): void {
  try {
    if (i === 0) localStorage.removeItem(SERVER_KEY);
    else localStorage.setItem(SERVER_KEY, JSON.stringify({ base: list[i], at: Date.now() }));
  } catch { /* storage unavailable */ }
}

function chanUrl(base: string, ch: Channel): string {
  const s = CFG.stream;
  return base + '/live/' + encodeURIComponent(s.username || '') + '/' +
         encodeURIComponent(s.password || '') + '/' + ch.id + '.m3u8';
}

/** Full stop: frees the single provider connection (FR-T5). */
function chanStop(): void {
  chanGen++;
  if (hls) { try { hls.stopLoad(); hls.detachMedia(); hls.destroy(); } catch { /* already gone */ } hls = null; }
  const v = $<HTMLVideoElement>('chanVideo');
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
  v.style.display = 'none';
  lastStopAt = Date.now();
}

/** Next channel in direction `dir` that is inside its viewing time, or -1. */
function nextAllowed(from: number, dir: 1 | -1): number {
  for (let n = 1; n <= channels.length; n++) {
    const k = (from + dir * n + channels.length * 2) % channels.length;
    if (allowed(chanKey(channels[k]))) return k;
  }
  return -1;
}

const chanKey = (ch: Channel): string => 'ch:' + ch.id;

function playChannel(i: number): void {
  if (!channels.length) return;
  chanIndex = (i + channels.length) % channels.length;
  const ch = channels[chanIndex];
  if (!allowed(chanKey(ch))) { toast(lockMessage(chanKey(ch))); return; }
  if (player.kind !== 'chan') openPlayer('chan');
  player.key = chanKey(ch);
  chanStop();
  const gen = chanGen;
  showPlayerMsg('📺', ch.name + ' ...');
  showTitle(ch.name);
  loadCfg().then(() => {
    let urls: string[], first = 0, worked: (i: number) => void = () => {};
    if (ch.url) {
      urls = [ch.url];                                    // direct link: one address, no account
    } else {
      const list = servers();
      if (!list.length || !CFG.stream.username) { showPlayerMsg('⚙️', 'القنوات غير مُعدّة بعد'); return; }
      urls = list.map((b) => chanUrl(b, ch));
      first = firstServer(list);
      worked = (i) => rememberServer(list, i);
    }
    const grace = Math.max(0, graceMs() - (Date.now() - lastStopAt));
    setTimeout(() => { if (gen === chanGen) startHls(urls, first, 0, 0, gen, worked); }, grace);
  });
}

const graceMs = (): number => CFG.stream.reconnectGraceMs || 3000;

/**
 * Plays stream URL `list[idx]` (one per server of the same channel). On a fatal error or a timeout (see ANSWER/PICTURE_TIMEOUT_MS) the next server is tried
 * (`tried` counts servers in this round); when every server failed, a new round starts after a back-off.
 */
function startHls(list: string[], idx: number, tried: number, round: number, gen: number, worked: (i: number) => void): void {
  if (gen !== chanGen || !Hls.isSupported()) return;
  const v = $<HTMLVideoElement>('chanVideo');
  v.style.display = 'block';
  const h = new Hls({ lowLatencyMode: false, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 3, startFragPrefetch: false });
  hls = h;
  let recovered = false, done = false;

  const fail = (): void => {
    if (done || gen !== chanGen) return;
    done = true;
    clearTimeout(watchdog);
    try { h.destroy(); } catch { /* ignore */ }      // close this connection before opening another
    if (hls === h) hls = null;
    lastStopAt = Date.now();
    const next = (idx + 1) % list.length;
    if (tried + 1 < list.length) {
      showPlayerMsg('⏳', 'نجرّب خادمًا آخر...');
      setTimeout(() => startHls(list, next, tried + 1, round, gen, worked), graceMs());
      return;
    }
    const delays = [3000, 8000, 15000];             // every server failed: retry with back-off (warm-up / busy)
    if (round < delays.length) {
      showPlayerMsg('⏳', 'نحاول تشغيل القناة...');
      setTimeout(() => startHls(list, next, 0, round + 1, gen, worked), Math.max(delays[round], graceMs()));
    } else {
      showPlayerMsg('🙈', 'القناة لا تعمل الآن، جرّب بعد قليل');
    }
  };
  let watchdog = setTimeout(fail, ANSWER_TIMEOUT_MS);  // a server that hangs without an error

  h.on(Hls.Events.ERROR, (_e, d) => {
    if (!d.fatal || gen !== chanGen || done) return;
    if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; h.recoverMediaError(); return; }
    fail();
  });
  h.on(Hls.Events.MANIFEST_PARSED, () => {            // the server answered: give it time to start the picture
    if (done) return;
    clearTimeout(watchdog);
    watchdog = setTimeout(fail, PICTURE_TIMEOUT_MS);
  });
  h.on(Hls.Events.MEDIA_ATTACHED, () => h.loadSource(list[idx]));
  v.onplaying = () => {
    if (gen !== chanGen || done) return;
    clearTimeout(watchdog);
    hidePlayerMsg();
    worked(idx);
  };
  h.attachMedia(v);
  v.play().catch(() => {});
}

/** Remote keys while a channel plays: arrows switch channel. */
export function channelKey(k: number): void {
  const dir = k === 40 || k === 37 ? 1 : k === 38 || k === 39 ? -1 : 0;
  if (!dir) return;
  const next = nextAllowed(chanIndex, dir);      // skips channels outside their viewing time
  if (next >= 0 && next !== chanIndex) playChannel(next);
}

/** (Re)reads data/channels.json; the row is rebuilt only when names/logos/order changed (phone admin, UX-AUDIT K3). */
function loadChannels(): Promise<void> {
  const row = $('chanRow');
  return getJson<{ channels?: Channel[] }>('data/channels.json').then((j) => {
    // the file is in shared storage: only well-formed entries are used (AUDIT-3 S6, same rules as validChannels)
    const list = (j.channels || []).filter((c) => c && typeof c.name === 'string' && c.name.trim()
      && (/^\d{1,10}$/.test(c.id) ? !c.url : /^u[a-z0-9]{4,16}$/.test(c.id) && /^https?:\/\/[^\s"'<>\\]{4,500}$/.test(c.url || ''))
      && (!c.icon || /^(channel_icons|user_icons)\/[A-Za-z0-9_.-]{1,80}$/.test(c.icon)));
    if (!list.length) throw new Error('empty');
    const sig = JSON.stringify(list.map((c) => [c.id, c.name, c.icon]));
    if (row.dataset.sig === sig || player.kind === 'chan') return;   // never renumber while a channel plays (retried later)
    row.dataset.sig = sig;
    channels = list;
    renderKeepingFocus(row, () => row.replaceChildren(...list.map((ch, i) =>
      makeItem(ch.name, { img: ch.icon || null, contain: true, emoji: '📺', key: chanKey(ch), fid: 'ch:' + ch.id, onclick: () => playChannel(i) }))));
  }).catch(() => {
    if (row.children.length) return;                 // keep what is shown on a read error
    for (const n of DEFAULT_CHANNELS) row.appendChild(makeItem(n, { emoji: '📺', soon: true, onclick: () => toast('قريبًا جدًا 😊') }));
  });
}

export function initChannels(): Promise<void> {
  onPlayerStop('chan', chanStop);
  setInterval(() => { loadChannels(); }, 2 * 60 * 1000);
  return loadChannels();
}
