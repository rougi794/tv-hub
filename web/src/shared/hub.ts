// Shared helpers for both interfaces: the TV Hub local API (127.0.0.1:8765, see LauncherService.java).
// The API is called under /api/hub/...: Service Workers pass /api/* through to the network, never from cache.

export const HUB_VERSION: string = __HUB_VERSION__;   // package.json "version"

export type HubMode = 'home' | 'kids';

export interface HubApp { pkg: string; label: string; kid?: boolean }

const API = location.port === '8765' ? '/api/hub' : 'http://127.0.0.1:8765/api/hub';

export function hubApi<T>(path: string): Promise<T> {
  return fetch(API + path, { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json() as Promise<T>;
  });
}

export function getJson<T>(path: string): Promise<T> {
  return fetch(path, { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json() as Promise<T>;
  });
}

export function getMode(): Promise<HubMode> {
  return hubApi<{ mode?: string }>('/mode').then((j) => (j.mode === 'kids' ? 'kids' : 'home'));
}

export function pageFor(mode: HubMode): string {
  return mode === 'kids' ? 'kids.html' : 'home.html';
}

export function iconUrl(pkg: string): string {
  return API + '/icon?pkg=' + encodeURIComponent(pkg);
}

/** Starts an installed app. In kids mode the TV refuses apps outside the child's list unless `pin` is the owner PIN. */
export function launchApp(pkg: string, pin?: string): Promise<boolean> {
  const q = '/launch?pkg=' + encodeURIComponent(pkg) + (pin ? '&pin=' + encodeURIComponent(pin) : '');
  return hubApi<{ ok?: boolean }>(q).then((j) => !!j.ok).catch(() => false);
}

/** Remote Back: TV Hub sends key "GoBack" / keyCode 4; browsers and Fully use Escape or BrowserBack. */
export function isBackKey(e: KeyboardEvent): boolean {
  return e.keyCode === 4 || e.keyCode === 27 || e.key === 'GoBack' || e.key === 'BrowserBack' || e.key === 'Escape';
}

/** "انتظر 4 دقائق" style text for a lockout of `ms` milliseconds (the TV locks 1, 2, 4 ... 60 minutes). */
export function waitText(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return 'محاولات كثيرة، انتظر ' + (m === 1 ? 'دقيقة' : m === 2 ? 'دقيقتين' : m + (m <= 10 ? ' دقائق' : ' دقيقة'));
}

export function isOkKey(e: KeyboardEvent): boolean {
  return e.keyCode === 13 || e.keyCode === 23 || e.key === 'Enter';
}

type Dir = 'L' | 'R' | 'U' | 'D';
export const ARROWS: Record<number, Dir> = { 37: 'L', 38: 'U', 39: 'R', 40: 'D' };

/** Spatial navigation: focus the nearest candidate in the arrow's direction (up/down prefer the next row). */
export function moveFocusAmong(items: HTMLElement[], dir: Dir): void {
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || items.indexOf(cur) < 0) { items[0]?.focus({ preventScroll: true }); return; }
  const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null, bestD = 1e9;
  for (const el of items) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect(), dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
    let main: number, cross: number;
    if (dir === 'L') { if (dx >= -1) continue; main = -dx; cross = Math.abs(dy); }
    else if (dir === 'R') { if (dx <= 1) continue; main = dx; cross = Math.abs(dy); }
    else if (dir === 'U') { if (dy >= -1) continue; main = -dy; cross = Math.abs(dx) / 4; }
    else { if (dy <= 1) continue; main = dy; cross = Math.abs(dx) / 4; }
    const d = main + cross * 2;
    if (d < bestD) { bestD = d; best = el; }
  }
  if (best) { best.focus({ preventScroll: true }); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
}
