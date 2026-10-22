// Small DOM helpers shared by the kids interface modules.
import { allowed, lockMessage, tagItem } from './timegate';

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

let toastTimer = 0;
export function toast(msg: string): void {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.style.display = 'none'; }, 2500);
}

/** Days since epoch in local time: changes at local midnight. */
export function dayIndex(): number {
  const d = new Date();
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
}

export function dateKey(): string {
  const d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

/** djb2 hash, same as the previous project and the phone admin page. */
export function dateSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) + h) + s.charCodeAt(i); h |= 0; }
  return Math.abs(h);
}

export interface ItemOptions {
  img?: string | null;
  contain?: boolean;
  emoji?: string;
  soon?: boolean;
  /** Schedule key ("yt:…", "ch:…"): outside its viewing time the item is locked. */
  key?: string;
  /** Stable id used to find the item again after its row is rebuilt (default: key + label). */
  fid?: string;
  onclick: () => void;
}

// ---- focus that survives re-rendering (UX-AUDIT K1) ----
// Rows are rebuilt when data refreshes; a saved element reference then points to a removed node and the
// child is left with nothing highlighted. Items carry data-fid, and focus is restored by id.

export function itemId(el: Element | null): string | null {
  return el instanceof HTMLElement ? el.dataset.fid ?? null : null;
}

export function findItem(fid: string | null): HTMLElement | null {
  return fid ? document.querySelector<HTMLElement>(`[data-fid="${CSS.escape(fid)}"]`) : null;
}

/** Rebuilds a row; if the focus was inside it, puts it back on the same item (or the one at the same place). */
export function renderKeepingFocus(row: HTMLElement, build: () => void): void {
  const a = document.activeElement as HTMLElement | null;
  const inRow = !!a && row.contains(a);
  const fid = inRow ? itemId(a) : null;
  const idx = inRow ? Array.from(row.children).indexOf(a as Element) : -1;
  build();
  if (!inRow) return;
  const target = findItem(fid) ?? (row.children[Math.min(Math.max(idx, 0), row.children.length - 1)] as HTMLElement | undefined);
  target?.focus({ preventScroll: true });
}

/** A round shelf item (channel, video, playlist, app). */
export function makeItem(label: string, opts: ItemOptions): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'item focusable' + (opts.soon ? ' soon' : '');
  b.tabIndex = 0;
  b.dataset.fid = opts.fid ?? (opts.key ?? '') + '|' + label;
  const c = document.createElement('div');
  c.className = 'circle';
  if (opts.img) {
    const img = new Image();
    img.src = opts.img;
    img.alt = '';
    if (opts.contain) img.className = 'contain';
    img.onerror = () => { c.textContent = opts.emoji || '⭐'; };
    c.appendChild(img);
  } else {
    c.textContent = opts.emoji || '⭐';
  }
  const s = document.createElement('div');
  s.className = 'label';
  s.textContent = label;
  b.append(c, s);
  const key = opts.key;
  b.onclick = key ? () => { if (allowed(key)) opts.onclick(); else toast(lockMessage(key)); } : opts.onclick;
  if (key) tagItem(b, key);
  return b;
}

/**
 * Marks shelves whose row has items hidden beyond an edge (UX-AUDIT K5): .more-left / .more-right show a fading
 * arrow on that side. RTL: scrollLeft is 0 at the start (right) and negative towards the left.
 */
export function markOverflow(): void {
  document.querySelectorAll<HTMLElement>('.shelf').forEach((shelf) => {
    const row = shelf.querySelector<HTMLElement>('.row');
    if (!row) return;
    const hidden = row.scrollWidth - row.clientWidth;
    const left = hidden > 2 && hidden + row.scrollLeft > 2;
    const right = row.scrollLeft < -2;
    shelf.classList.toggle('more-left', left);
    shelf.classList.toggle('more-right', right);
  });
}

export function emptyRow(row: HTMLElement, text: string): void {
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = text;
  row.replaceChildren(d);
}
