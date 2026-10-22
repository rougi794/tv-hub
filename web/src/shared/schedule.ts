// Viewing times for kids items, set by the owner from the phone (data/schedule.json).
//   keys: "yt:main" (main YouTube playlist), "yt:<playlistId>" (extra playlist), "ch:<streamId>" (TV channel)
// An item with no windows is always available. Times are the TV's local time.

export interface TimeWindow {
  from: string;          // "HH:MM"
  to: string;            // "HH:MM"; earlier than `from` means it ends after midnight
  days?: number[];       // 0 = Sunday ... 6 = Saturday; empty/missing = every day
}

export type Schedule = Record<string, TimeWindow[]>;

export interface ScheduleFile { items?: Schedule; updatedAt?: string }

export const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export const DAY_SHORT = ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];

const minutes = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : -1;
};

export function validWindow(w: TimeWindow): boolean {
  return minutes(w.from) >= 0 && minutes(w.to) >= 0 && w.from !== w.to;
}

/** True if `now` falls inside one of the windows (or there are none). */
export function isAllowed(wins: TimeWindow[] | undefined, now: Date = new Date()): boolean {
  const list = (wins || []).filter(validWindow);
  if (!list.length) return true;
  const m = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay(), yesterday = (today + 6) % 7;
  const onDay = (w: TimeWindow, d: number) => !w.days || !w.days.length || w.days.includes(d);
  return list.some((w) => {
    const f = minutes(w.from), t = minutes(w.to);
    if (f < t) return onDay(w, today) && m >= f && m < t;
    // overnight window: the evening part belongs to its start day, the early-morning part to the next day
    return (onDay(w, today) && m >= f) || (onDay(w, yesterday) && m < t);
  });
}

/** "4:00 م" style 12-hour time. */
export function formatTime(hhmm: string): string {
  const v = minutes(hhmm);
  if (v < 0) return hhmm;
  const h = Math.floor(v / 60), mm = v % 60, h12 = h % 12 || 12;
  return h12 + ':' + (mm < 10 ? '0' : '') + mm + (h < 12 ? ' ص' : ' م');
}

export function describeDays(days?: number[]): string {
  if (!days || !days.length || days.length === 7) return 'كل الأيام';
  return days.slice().sort().map((d) => DAY_SHORT[d]).join('، ');
}

export function describeWindow(w: TimeWindow): string {
  return formatTime(w.from) + ' – ' + formatTime(w.to) + (w.days && w.days.length && w.days.length < 7 ? ' (' + describeDays(w.days) + ')' : '');
}

/**
 * A picture for children who cannot read the clock yet (UX-AUDIT K7), from the start of the first window:
 * 🌅 morning (5–11), ☀️ afternoon (12–16), 🌇 evening (17–18), 🌙 night (19–4).
 */
export function dayPartEmoji(wins: TimeWindow[] | undefined): string {
  const list = (wins || []).filter(validWindow);
  if (!list.length) return '';
  const h = Math.floor(minutes(list[0].from) / 60);
  return h >= 5 && h < 12 ? '🌅' : h >= 12 && h < 17 ? '☀️' : h >= 17 && h < 19 ? '🌇' : '🌙';
}

/** Short text for the TV: "⏰ 4:00 م – 7:00 م" (+ " …" when there are more windows). */
export function describeShort(wins: TimeWindow[] | undefined): string {
  const list = (wins || []).filter(validWindow);
  if (!list.length) return '';
  return '⏰ ' + formatTime(list[0].from) + ' – ' + formatTime(list[0].to) + (list.length > 1 ? ' …' : '');
}
