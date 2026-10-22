// Full-screen player layer shared by YouTube and TV channels. No links: a transparent shield covers the player.
import { hubApi } from '../shared/hub';
import { $, findItem, itemId } from './ui';

/** Screen policy on the TV (HomeActivity): keep the screen on while a video/channel plays. */
const reportPlaying = (on: boolean): void => { hubApi('/screen?playing=' + (on ? 1 : 0)).catch(() => {}); };

export type PlayerKind = 'yt' | 'chan';

export interface CfgShape {
  stream: { baseUrl?: string; baseUrls?: string[]; username?: string; password?: string; reconnectGraceMs?: number };
  youtube: { apiKey?: string; playlistId?: string };
}

// config.json (served from the private folder, never on the LAN). Credentials are never shown or logged.
export const CFG: CfgShape = { stream: {}, youtube: {} };
/** (Re)reads config.json: settings saved from the phone apply on the next channel start / YouTube refresh. */
export function loadCfg(): Promise<void> {
  return fetch('config.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { userSettings?: Partial<CfgShape> } | null) => {
      if (!j) return;                                  // keep the last good settings on a read error
      const u = j.userSettings || {};
      CFG.stream = u.stream || {};
      CFG.youtube = u.youtube || {};
    })
    .catch(() => {});
}

/** `key` = schedule key of what is on screen (see timegate.ts). */
export const player: { kind: PlayerKind | null; key: string | null; returnFocus: Element | null; returnFid: string | null } =
  { kind: null, key: null, returnFocus: null, returnFid: null };
const stoppers: Partial<Record<PlayerKind, () => void>> = {};

/** Each source registers how to stop itself fully when the player closes. */
export function onPlayerStop(kind: PlayerKind, stop: () => void): void { stoppers[kind] = stop; }

export function showPlayerMsg(emoji: string, text: string): void {
  const m = $('playerMsg');
  const big = document.createElement('div');
  big.className = 'big';
  big.textContent = emoji;
  const t = document.createElement('div');
  t.textContent = text;
  m.replaceChildren(big, t);
  m.classList.add('show');
}

export function hidePlayerMsg(): void { $('playerMsg').classList.remove('show', 'solid'); }

// YouTube shows its title/logo overlay for ~3s when a video starts: keep an opaque cover until it is gone
let revealTimer = 0;
export function coverWhileStarting(): void { clearTimeout(revealTimer); $('playerMsg').classList.add('solid'); }
export function revealAfterStart(): void { clearTimeout(revealTimer); revealTimer = window.setTimeout(hidePlayerMsg, 3000); }

let titleTimer = 0;
export function showTitle(t: string): void {
  const el = $('playerTitle');
  el.textContent = t;
  el.classList.add('show');
  clearTimeout(titleTimer);
  titleTimer = window.setTimeout(() => el.classList.remove('show'), 4000);
}

export function controlsOpen(): boolean { return $('ctrlLayer').classList.contains('show'); }

/** Keys must reach this page, not the cross-origin YouTube iframe (Back/OK/arrows). */
export function keepKeys(): void { if (player.kind) $('shield').focus({ preventScroll: true }); }

export function openPlayer(kind: PlayerKind): void {
  player.returnFocus = document.activeElement;
  player.returnFid = itemId(document.activeElement);
  player.kind = kind;
  reportPlaying(true);
  $('playerLayer').classList.add('open');
  keepKeys();
}

export function closePlayer(focusFallback: () => void): void {
  const kind = player.kind;
  if (kind) stoppers[kind]?.();
  player.kind = null;
  player.key = null;
  reportPlaying(false);
  hidePlayerMsg();
  $('playerLayer').classList.remove('open');
  let f = player.returnFocus as HTMLElement | null;
  if (!f || !document.contains(f)) f = findItem(player.returnFid);   // its row was rebuilt meanwhile
  if (f) { f.focus({ preventScroll: true }); f.scrollIntoView({ block: 'nearest' }); }
  else focusFallback();
}

export function initPlayer(): void {
  window.addEventListener('blur', () => { if (player.kind && !controlsOpen()) setTimeout(keepKeys, 0); });
  setInterval(() => { if (player.kind && !controlsOpen() && document.activeElement !== $('shield')) keepKeys(); }, 1000);
}
