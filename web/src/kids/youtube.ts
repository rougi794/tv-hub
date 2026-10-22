// YouTube: Data API lists + IFrame player (DECISIONS D-008, D-012, D-013 of kids-tv-streaming-spec).
// Sources: the owner's main playlist (config.json youtube.playlistId) shown as videos, plus extra playlists
// added from the phone (data/playlists.json { updatedAt, playlists:[{id,name}] }) shown as one circle each.
import { getJson } from '../shared/hub';
import {
  CFG, controlsOpen, coverWhileStarting, hidePlayerMsg, keepKeys, loadCfg, onPlayerStop, openPlayer, player,
  revealAfterStart, showPlayerMsg, showTitle,
} from './player';
import { allowed, lockMessage } from './timegate';
import { $, emptyRow, makeItem, renderKeepingFocus, toast } from './ui';

interface Video { id: string; title: string }
interface Playlist { id: string; name: string; videos: Video[] }
interface PlaylistsFile { updatedAt?: string; playlists?: { id: string; name?: string }[] }
interface Cache { t: number; sig: string; main: Video[]; extras: Playlist[] }

const YT_CACHE = 'yt_cache_v2', YT_TTL = 60 * 60 * 1000, YT_ROW_MAX = 7;
let mainVideos: Video[] = [], extras: Playlist[] = [];
let videos: Video[] = [], ytIndex = 0;          // the list being played
let videosKey = 'yt:main';                     // its schedule key
let ytPlayer: YTPlayer | null = null, ytApiPromise: Promise<void> | null = null, ytSkipTimer = 0;
let ytLoading: Promise<number> | null = null;

function ytGet<T>(path: string): Promise<T> {
  return fetch('https://www.googleapis.com/youtube/v3/' + path + '&key=' + encodeURIComponent(CFG.youtube.apiKey || ''))
    .then((r) => r.json())
    .then((j: T & { error?: { code: number } }) => { if (j.error) throw new Error('api ' + j.error.code); return j; });
}

interface ItemsPage { items?: { snippet: { title: string; resourceId: { videoId: string } } }[]; nextPageToken?: string }

function fetchPlaylist(id: string): Promise<Video[]> {
  const all: Video[] = [];
  const page = (token: string): Promise<Video[]> =>
    ytGet<ItemsPage>('playlistItems?part=snippet&maxResults=50&playlistId=' + encodeURIComponent(id) + (token ? '&pageToken=' + token : ''))
      .then((j) => {
        for (const it of j.items || []) {
          const s = it.snippet;
          if (/^(Private|Deleted) video$/.test(s.title)) continue;
          all.push({ id: s.resourceId.videoId, title: s.title });
        }
        return j.nextPageToken && all.length < 500 ? page(j.nextPageToken) : all;
      });
  return page('');
}

function fetchTitles(ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return Promise.resolve({});
  return ytGet<{ items?: { id: string; snippet: { title: string } }[] }>('playlists?part=snippet&maxResults=50&id=' + ids.map(encodeURIComponent).join(','))
    .then((j) => { const m: Record<string, string> = {}; for (const p of j.items || []) m[p.id] = p.snippet.title; return m; })
    .catch(() => ({}));
}

function readCache(): Cache | null { try { return JSON.parse(localStorage.getItem(YT_CACHE) || 'null') as Cache | null; } catch { return null; } }
function writeCache(sig: string): void {
  try { localStorage.setItem(YT_CACHE, JSON.stringify({ t: Date.now(), sig, main: mainVideos, extras })); } catch { /* ignore */ }
}

const thumb = (id: string): string => 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg';

function renderYouTube(): void {
  const row = $('ytRow');
  if (!mainVideos.length && !extras.length) { emptyRow(row, 'لا توجد فيديوهات بعد'); return; }
  // unchanged data: keep the existing nodes (rebuilding dropped the focus, UX-AUDIT K1)
  const sig = JSON.stringify([mainVideos.slice(0, YT_ROW_MAX + 1), extras.map((p) => [p.id, p.name, p.videos[0]?.id])]);
  if (row.dataset.sig === sig) return;
  row.dataset.sig = sig;
  renderKeepingFocus(row, () => {
    row.replaceChildren();
    mainVideos.slice(0, YT_ROW_MAX).forEach((v, i) => {
      row.appendChild(makeItem(v.title, { img: thumb(v.id), emoji: '▶️', key: 'yt:main', fid: 'v:' + v.id, onclick: () => playFrom(mainVideos, i, 'yt:main') }));
    });
    if (mainVideos.length > YT_ROW_MAX) {
      row.appendChild(makeItem('المزيد', { emoji: '➕', key: 'yt:main', fid: 'more', onclick: () => openYtList('▶️ كل الفيديوهات', mainVideos, 'more', 'yt:main') }));
    }
    for (const pl of extras) {
      if (!pl.videos.length) continue;
      const key = 'yt:' + pl.id;
      row.appendChild(makeItem('📂 ' + pl.name, { img: thumb(pl.videos[0].id), emoji: '📂', key, fid: 'pl:' + pl.id,
        onclick: () => openYtList('📂 ' + pl.name, pl.videos, 'pl:' + pl.id, key) }));
    }
  });
}

/** Refresh the lists; force=true ignores the cache TTL. Resolves to the number of videos, or -1 on failure. */
export function loadYouTube(force = false): Promise<number> {
  if (ytLoading) return ytLoading;
  const c = readCache();
  if (c && c.main && !mainVideos.length && !extras.length) { mainVideos = c.main; extras = c.extras || []; renderYouTube(); }
  ytLoading = Promise.all([loadCfg(), getJson<PlaylistsFile>('data/playlists.json').catch((): PlaylistsFile => ({}))])
    .then(([, pc]) => {
      const list = (pc.playlists || []).filter((p) => p && /^[A-Za-z0-9_-]{10,64}$/.test(p.id));
      const sig = (pc.updatedAt || '') + '|' + list.map((p) => p.id).join(',');
      if (!force && c && c.sig === sig && Date.now() - c.t < YT_TTL) return 0;
      if (!CFG.youtube.apiKey) throw new Error('no key');
      const main = CFG.youtube.playlistId ? fetchPlaylist(CFG.youtube.playlistId).catch(() => mainVideos) : Promise.resolve([] as Video[]);
      const needTitles = list.filter((p) => !p.name).map((p) => p.id);
      return Promise.all([main, fetchTitles(needTitles), Promise.all(list.map((p) => fetchPlaylist(p.id).catch(() => [] as Video[])))])
        .then(([m, titles, lists]) => {
          mainVideos = m;
          extras = list.map((p, i) => ({ id: p.id, name: p.name || titles[p.id] || 'قائمة', videos: lists[i] }));
          writeCache(sig);
          renderYouTube();
          return mainVideos.length + extras.reduce((n, p) => n + p.videos.length, 0);
        });
    })
    .catch(() => { if (!mainVideos.length && !extras.length) renderYouTube(); return -1; })
    .then((n) => { ytLoading = null; return n; });
  return ytLoading;
}

// ---------------- vertical list (FR-Y3), shared by "more" and every extra playlist ----------------
let listVideos: Video[] = [], listKey = 'yt:main';
/** data-fid of the circle the list was opened from (an id, not a node: the row may be rebuilt meanwhile). */
export let listReturn: string | null = null;

function openYtList(title: string, list: Video[], returnFid: string, key: string): void {
  listVideos = list;
  listKey = key;
  listReturn = returnFid;
  $('ytListTitle').textContent = title;
  const box = $('ytList');
  box.replaceChildren();
  const series = title.replace(/^\S+\s+/, '');                 // list name without its emoji
  list.forEach((v, i) => {
    const b = document.createElement('button');
    b.className = 'vitem focusable';
    b.tabIndex = 0;
    const img = new Image(); img.src = thumb(v.id); img.alt = '';
    const t = document.createElement('div'); t.className = 'vtext';
    const name = document.createElement('span'); name.textContent = (i + 1) + '. ' + shortTitle(v.title, series);
    b.addEventListener('focus', () => { $('ytListCount').textContent = `${i + 1} / ${list.length}`; });
    const bar = document.createElement('div'); bar.className = 'vprog'; bar.appendChild(document.createElement('i'));
    t.append(name, bar);
    b.append(img, t);
    b.onclick = () => playFrom(listVideos, i, listKey);
    box.appendChild(b);
  });
  $('ytListLayer').classList.add('open');
  refreshListProgress();
  // continue where the child left off: focus the first unfinished episode after the last watched one
  let start = 0;
  list.forEach((v, k) => { const p = progGet(v.id); if (p && (p.done || p.t)) start = p.done ? k + 1 : k; });
  const target = (box.children[Math.min(start, list.length - 1)] || box.firstChild) as HTMLElement | null;
  if (target) { target.focus(); target.scrollIntoView({ block: 'center' }); }
}

/**
 * Episode title without the words it shares with the series name and the usual noise (UX-AUDIT K8):
 * "صقور الأرض الحلقة 2 Full HD" in the list "صقور الارض" -> "الحلقة 2". Falls back to the full title if too little is left.
 */
export function shortTitle(title: string, series: string): string {
  const norm = (s: string) => s.replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase();
  const seriesWords = new Set(norm(series).split(/\s+/).filter((w) => w.length > 1));
  const kept = title.split(/\s+/).filter((w) => !seriesWords.has(norm(w)) && !/^(full|hd|fhd|4k|\||-|–|:)$/i.test(w));
  const short = kept.join(' ').replace(/^[\s|\-–:]+|[\s|\-–:]+$/g, '');
  return short.length >= 3 ? short : title;
}

function playFrom(list: Video[], i: number, key: string): void {
  if (!allowed(key)) { toast(lockMessage(key)); return; }
  videos = list;
  videosKey = key;
  playVideo(i);
}

function loadYtApi(): Promise<void> {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise<void>((resolve, reject) => {
    window.onYouTubeIframeAPIReady = resolve;
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApiPromise = null; reject(new Error('api')); };
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

// ---------------- watch progress: resume where the child stopped (per video id) ----------------
interface Progress { t: number; d: number; done: boolean; at: number }
const PROG_KEY = 'yt_progress_v1';
let progTimer = 0;
function progAll(): Record<string, Progress> { try { return JSON.parse(localStorage.getItem(PROG_KEY) || '{}'); } catch { return {}; } }
function progGet(id: string): Progress | null { return progAll()[id] || null; }
function progSet(id: string, rec: Progress): void {
  const all = progAll();
  all[id] = rec;
  const ids = Object.keys(all);
  if (ids.length > 400) {                      // keep the 400 most recent
    ids.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
    for (const k of ids.slice(0, ids.length - 400)) delete all[k];
  }
  try { localStorage.setItem(PROG_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}
function saveProgress(): void {
  if (!ytPlayer || !ytPlayer.getCurrentTime || !videos[ytIndex]) return;
  const t = ytPlayer.getCurrentTime() || 0, d = ytPlayer.getDuration() || 0;
  if (t < 5 || !d) return;
  progSet(videos[ytIndex].id, { t: Math.floor(t), d: Math.floor(d), done: t > d - 20, at: Date.now() });
}
function startAt(id: string): number {
  const p = progGet(id);
  return p && !p.done && p.t > 10 ? Math.max(0, p.t - 3) : 0;
}

function captionsOff(p: YTPlayer): void {      // no subtitles / auto-translation on screen
  try { p.unloadModule('captions'); } catch { /* not loaded */ }
  try { p.unloadModule('cc'); } catch { /* not loaded */ }
}

function playVideo(i: number): void {
  if (!videos.length) return;
  saveProgress();
  hideControls();
  ytIndex = (i + videos.length) % videos.length;
  if (player.kind !== 'yt') openPlayer('yt');
  player.key = videosKey;
  showPlayerMsg('⏳', 'لحظة...');
  coverWhileStarting();
  loadYtApi().then(() => {
    const v = videos[ytIndex], start = startAt(v.id);
    if (start) toast('نكمل من حيث توقفنا ⏩');
    if (ytPlayer) { ytPlayer.loadVideoById({ videoId: v.id, startSeconds: start }); showTitle(v.title); return; }
    const host = $('ytHost');
    const frame = document.createElement('div');
    frame.id = 'ytFrame';
    host.replaceChildren(frame);
    ytPlayer = new window.YT!.Player('ytFrame', {
      videoId: v.id,
      playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, disablekb: 1, fs: 0, iv_load_policy: 3,
                    cc_load_policy: 0, hl: 'ar', playsinline: 1, start, origin: location.origin },
      events: {
        onReady: (e: YTEvent) => {
          e.target.getIframe().setAttribute('tabindex', '-1');
          captionsOff(e.target);
          e.target.playVideo();
          showTitle(videos[ytIndex].title);
          keepKeys();
        },
        onApiChange: (e: YTEvent) => captionsOff(e.target),
        onStateChange: (e: YTEvent) => {
          if (e.data === 1) {                                        // playing
            captionsOff(e.target);
            if ($('playerMsg').classList.contains('solid')) revealAfterStart(); else hidePlayerMsg();
          }
          if (e.data === 0) {                                        // ended -> mark done, next (no suggestions)
            const cur = videos[ytIndex];
            if (cur) progSet(cur.id, { t: 0, d: 0, done: true, at: Date.now() });
            playVideo(ytIndex + 1);
          }
        },
        onError: () => {                                           // 2,5,100,101,150,153 -> skip
          showPlayerMsg('🙈', 'هذا الفيديو لا يعمل، ننتقل للتالي');
          clearTimeout(ytSkipTimer);
          ytSkipTimer = window.setTimeout(() => { if (player.kind === 'yt') playVideo(ytIndex + 1); }, 2500);
        },
      },
    });
    clearInterval(progTimer);
    progTimer = window.setInterval(() => { if (ytPlayer?.getPlayerState && ytPlayer.getPlayerState() === 1) saveProgress(); }, 5000);
  }).catch(() => showPlayerMsg('📡', 'تعذر تحميل يوتيوب، تأكد من الإنترنت'));
}

function ytStop(): void {
  saveProgress();
  clearInterval(progTimer);
  clearTimeout(ytSkipTimer);
  hideControls();
  if (ytPlayer) { try { ytPlayer.destroy(); } catch { /* already gone */ } ytPlayer = null; }
  $('ytHost').replaceChildren();
  refreshListProgress();
}

// ---------------- seeking (←/→ while playing) with an on-screen indicator ----------------
function fmt(s: number): string { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
let osdTimer = 0;
function showOsd(text: string): void {
  if (!ytPlayer || !ytPlayer.getDuration) return;
  const d = ytPlayer.getDuration() || 0, t = ytPlayer.getCurrentTime() || 0;
  $('osdText').textContent = text;
  $('osdTime').textContent = fmt(t) + ' / ' + fmt(d);
  $('osdFill').style.width = (d ? Math.min(100, t * 100 / d) : 0) + '%';
  const o = $('osd');
  o.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = window.setTimeout(() => o.classList.remove('show'), 2500);
}
function seekBy(sec: number): void {
  if (!ytPlayer || !ytPlayer.getCurrentTime) return;
  const d = ytPlayer.getDuration() || 0;
  const t = Math.min(Math.max(0, (ytPlayer.getCurrentTime() || 0) + sec), Math.max(0, d - 2));
  ytPlayer.seekTo(t, true);
  setTimeout(() => showOsd(sec > 0 ? '⏩ +' + sec : '⏪ ' + sec), 150);
}

// ---------------- pause screen with a control bar (OK while playing) ----------------
function showControls(): void {
  if (!ytPlayer || !ytPlayer.pauseVideo) return;
  ytPlayer.pauseVideo();
  saveProgress();
  const v = videos[ytIndex], d = ytPlayer.getDuration() || 0, t = ytPlayer.getCurrentTime() || 0;
  $('ctrlTitle').textContent = v ? v.title : '';
  $('ctrlTime').textContent = fmt(t) + ' / ' + fmt(d);
  $('ctrlFill').style.width = (d ? t * 100 / d : 0) + '%';
  $('ctrlLayer').classList.add('show');
  $('cPlay').focus({ preventScroll: true });
}
function hideControls(): void { $('ctrlLayer').classList.remove('show'); }
function resumeFromControls(): void { hideControls(); ytPlayer?.playVideo(); keepKeys(); }
function ctrlMove(dir: number): void {
  const b = Array.from(document.querySelectorAll<HTMLElement>('#ctrlBar button'));
  let i = b.indexOf(document.activeElement as HTMLElement);
  if (i < 0) { $('cPlay').focus(); return; }
  i = Math.min(b.length - 1, Math.max(0, i + dir));
  b[i].focus({ preventScroll: true });
}

function refreshListProgress(): void {
  const items = $('ytList').children;
  for (let i = 0; i < items.length && i < listVideos.length; i++) {
    const p = progGet(listVideos[i].id), bar = items[i].querySelector<HTMLElement>('.vprog i');
    if (bar) bar.style.width = p ? (p.done ? 100 : (p.d ? Math.round(p.t * 100 / p.d) : 0)) + '%' : '0%';
    items[i].classList.toggle('done', !!(p && p.done));
  }
}

/** Remote keys while a video plays: OK = pause screen, ←/→ = seek 10s (never skips videos), ↑/↓ = show position. */
export function ytKey(k: number): void {
  if (controlsOpen()) {
    if (k === 13 || k === 23) (document.activeElement as HTMLElement | null)?.click();
    if (k === 37) ctrlMove(-1);
    if (k === 39) ctrlMove(1);
    return;
  }
  if (k === 13 || k === 23) showControls();
  if (k === 39) seekBy(10);                     // → forward (media convention, also in RTL)
  if (k === 37) seekBy(-10);                    // ← back
  if (k === 38 || k === 40) showOsd('▶️');
}

export function initYouTube(): void {
  onPlayerStop('yt', ytStop);
  $('cPlay').onclick = resumeFromControls;
  $('cBack').onclick = () => { resumeFromControls(); seekBy(-10); };
  $('cFwd').onclick = () => { resumeFromControls(); seekBy(10); };
  $('cPrev').onclick = () => playVideo(ytIndex - 1);
  $('cNext').onclick = () => playVideo(ytIndex + 1);
  loadYouTube();
  // reads data/playlists.json; calls the API only when it changed or the 1h cache expired
  setInterval(() => loadYouTube(false), 5 * 60 * 1000);
}
