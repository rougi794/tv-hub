// Viewing times on the kids page: items outside their window show a lock and the allowed time,
// cannot be opened, and a video/channel that is playing stops when its window ends.
import { getJson } from '../shared/hub';
import { dayPartEmoji, describeShort, describeWindow, isAllowed, validWindow, type Schedule, type ScheduleFile } from '../shared/schedule';

let schedule: Schedule = {};

export function allowed(key: string | null | undefined): boolean {
  return !key || isAllowed(schedule[key]);
}

export function lockMessage(key: string): string {
  const list = (schedule[key] || []).filter(validWindow);
  return dayPartEmoji(list) + ' متاح ' + list.map(describeWindow).join(' و ');
}

function applyOne(el: HTMLElement): void {
  const key = el.dataset.key;
  const locked = !allowed(key);
  el.classList.toggle('locked', locked);
  let t = el.querySelector<HTMLElement>('.lockTime');
  if (locked && key) {
    if (!t) { t = document.createElement('div'); t.className = 'lockTime'; el.appendChild(t); }
    t.textContent = dayPartEmoji(schedule[key]) + ' ' + describeShort(schedule[key]).replace('⏰ ', '');
  } else if (t) {
    t.remove();
  }
}

/** Marks a shelf item with its schedule key and shows its current lock state. */
export function tagItem(el: HTMLElement, key: string): void {
  el.dataset.key = key;
  applyOne(el);
}

function applyLocks(): void {
  document.querySelectorAll<HTMLElement>('[data-key]').forEach(applyOne);
}

function loadSchedule(): Promise<void> {
  return getJson<ScheduleFile>('data/schedule.json')
    .then((j) => { schedule = j.items || {}; })
    .catch(() => { /* no file yet: everything stays available; on a read error keep the last schedule */ })
    .then(applyLocks);
}

/**
 * Re-reads the schedule (owner changes from the phone) and re-checks every 30 s.
 * `playingKey` returns the key of what is on screen; `stop` is called when its time is over.
 */
export function initTimeGate(playingKey: () => string | null, stop: () => void): Promise<void> {
  setInterval(() => {
    loadSchedule().then(() => { const k = playingKey(); if (k && !allowed(k)) stop(); });
  }, 30 * 1000);
  return loadSchedule();
}
