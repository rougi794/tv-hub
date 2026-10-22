/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Clock,
  Sun,
  AlertTriangle,
  Lock,
  Settings,
  Wifi,
  Image as ImageIcon,
  BookOpen,
  Heart,
  Utensils,
  ChevronRight,
  ChevronLeft,
  ChevronUp,
  ChevronDown,
  X,
  Plus,
  Trash2,
  Youtube,
  Tv,
  Newspaper,
  Store,
  Search,
  Trophy,
  AppWindow,
  Loader2,
  RefreshCw,
  UserCog,
  WifiOff,
  Bell,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { APP_VERSION } from './version';

// عند التشغيل داخل Fully Kiosk على التلفزيون يتوفّر كائن window.fully.
// نستخدمه للتفريق بين واجهة التلفزيون (ريموت فقط) وواجهة الهاتف (لمس).
const isTvDevice = (): boolean => typeof window !== 'undefined' && !!window.fully;

// --- Types ---
interface PrayerTimes {
  Fajr: string;
  Sunrise: string;
  Dhuhr: string;
  Asr: string;
  Maghrib: string;
  Isha: string;
}

interface WeatherData {
  temp: number;
  condition: string;
  icon: string;
  warning?: string;
}

interface QuickLink {
  type: 'app' | 'url';
  label: string;
  pkg?: string;
  url?: string;
  icon: string;
  iconUrl?: string;
}

interface QuranAyah {
  number: number;
  numberInSurah: number;
  text: string;
  surah: { number: number; name: string; englishName?: string };
}

interface QuranPage {
  page: number;
  ayahs: QuranAyah[];
}

interface WifiInfo {
  ssid: string;
  password: string;
  qrImage?: string;
}

interface NewsSource {
  name: string;
  url: string;
}

interface MotdResponse {
  messages: string[];
}

interface MealsResponse {
  meals: string[];
}

interface Reminder {
  id: string;
  time: string;
  text: string;
  seconds?: number;
  days?: number[];   // 0 = Sunday ... 6 = Saturday; missing = every day
}

interface RemindersResponse {
  reminders: Reminder[];
}

interface ImagesResponse {
  images: string[];
}

interface AdhkarResponse {
  morning: string[];
  evening: string[];
}

interface Config {
  userSettings: {
    location: { city: string; country: string; timeZone: string; lat: number; lon: number };
    quran: { startDate: string };
    security: { pinCode: string };
    prayerMethod: number;
    locale: string;
  };
  appearance?: {
    backgroundImage?: string;
    backgroundDim?: number;
  };
  appConfig: {
    news: { limitPerSource: number; refreshIntervalMinutes: number };
    files: Record<string, string>;
  };
}

declare global {
  interface Window {
    fully?: {
      loadUrl?: (url: string) => void;
      startApplication?: (packageName: string) => void;
      // دوال تعداد التطبيقات تختلف تسميتها بين إصدارات Fully؛ كلها اختيارية
      // ونتحسّسها ديناميكياً وقت التشغيل. [key: string] يسمح بذلك دون كسر الأنواع.
      [key: string]: unknown;
    };
    webkitAudioContext?: typeof AudioContext;
  }
}

// نُطبِّع نتيجة تعداد التطبيقات إلى { pkg, label } بغضّ النظر عن شكلها.
const normalizeInstalledApps = (arr: unknown[]): { pkg: string; label: string }[] => {
  const out: { pkg: string; label: string }[] = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      if (item) out.push({ pkg: item, label: item });
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const pkg = (o.packageName || o.package || o.pkg || o.id) as string | undefined;
      const label = (o.applicationName || o.appName || o.label || o.name || o.title || pkg) as string | undefined;
      if (pkg) out.push({ pkg, label: label || pkg });
    }
  }
  // إزالة التكرار حسب الحزمة، وترتيب أبجدي حسب الاسم.
  const seen = new Set<string>();
  return out
    .filter((a) => (seen.has(a.pkg) ? false : (seen.add(a.pkg), true)))
    .sort((a, b) => a.label.localeCompare(b.label));
};

// نقرأ قائمة التطبيقات المثبّتة من واجهة Fully، مجرّبين أسماء الدوال المحتملة.
const readInstalledAppsFromFully = (): { pkg: string; label: string }[] | null => {
  const f = window.fully as Record<string, unknown> | undefined;
  if (!f) return null;
  const candidates = ['getInstalledApps', 'getInstalledPackages', 'listApps', 'getInstalledApplications'];
  for (const name of candidates) {
    const fn = f[name];
    if (typeof fn === 'function') {
      try {
        const raw = (fn as () => unknown).call(f);
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) {
          const norm = normalizeInstalledApps(parsed);
          if (norm.length) return norm;
        }
      } catch {
        // جرّب الاسم التالي
      }
    }
  }
  return null;
};

// كتابة ملف JSON إلى السيرفر عبر واجهة Simple HTTP Server (نفس آلية لوحة الإدارة).
const putJsonFile = async (dir: string, filename: string, payload: unknown) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const file = new File([blob], filename, { type: 'application/json' });
  const form = new FormData();
  form.append('files[]', file);
  const params = new URLSearchParams({ path: dir });
  const res = await fetch(`/api/file/upload?${params.toString()}`, { method: 'PUT', body: form });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
};

const DEFAULT_NEWS = ['لا توجد أخبار حالياً - يرجى التحقق من الاتصال'];
const DEFAULT_MEAL = 'لا توجد وجبات مسجلة';
const DAILY_MOTD_KEY = 'daily_motd_pick';
const DAILY_IMAGE_KEY = 'daily_image_pick';
const DAILY_MEAL_KEY = 'daily_meal_pick';
const QURAN_CACHE_PREFIX = 'quran_page_v1_';
const QURAN_PAGE_API = 'https://api.alquran.cloud/v1/page';
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const fetchJson = async <T,>(url: string, fallback: T, timeoutMs = 8000): Promise<T> => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (error) {
    console.warn(`Failed to load ${url}`, error);
    return fallback;
  } finally {
    window.clearTimeout(timer);
  }
};

const pickRandom = (items: string[] | undefined, fallback = '') => {
  if (!Array.isArray(items) || items.length === 0) return fallback;
  return items[Math.floor(Math.random() * items.length)] || fallback;
};

const getDateKey = (timeZone = 'Asia/Riyadh') => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((p) => p.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const dateSeed = (key: string) => {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash) + key.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

const pickDailyItem = (storageKey: string, dateKey: string, items: string[], fallback = '') => {
  if (!Array.isArray(items) || items.length === 0) return fallback;

  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || '{}') as { date?: string; value?: string };
    if (stored.date === dateKey && stored.value && items.includes(stored.value)) {
      return stored.value;
    }
  } catch {
    // Ignore broken localStorage; the deterministic fallback below still gives a stable daily pick.
  }

  const idx = dateSeed(`${storageKey}-${dateKey}`) % items.length;
  const value = items[idx] || fallback;
  try {
    localStorage.setItem(storageKey, JSON.stringify({ date: dateKey, value }));
  } catch {
    // localStorage may be unavailable; deterministic pick still works.
  }
  return value;
};

const safeParseObject = (value: string | null): Record<string, number> => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const weatherCodeToCondition = (code: number) => {
  if ([0, 1].includes(code)) return 'مشمس';
  if ([2, 3].includes(code)) return 'غائم جزئياً';
  if ([45, 48].includes(code)) return 'ضباب';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'أمطار';
  if (code >= 95) return 'عواصف';
  return 'غائم';
};

const loadPrayerTimes = async (config: Config): Promise<PrayerTimes | null> => {
  const { city, country } = config.userSettings.location;
  const method = config.userSettings.prayerMethod;
  const url = `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=${method}`;
  const data = await fetchJson<{ data?: { timings?: PrayerTimes } } | null>(url, null, 7000);
  return data?.data?.timings ?? null;
};

const loadWeather = async (config: Config): Promise<WeatherData | null> => {
  const { lat, lon } = config.userSettings.location;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&hourly=wind_speed_10m,precipitation_probability&forecast_days=1`;
  const data = await fetchJson<any | null>(url, null, 7000);
  if (!data?.current || !data?.hourly) return null;

  const precipitation = Array.isArray(data.hourly.precipitation_probability)
    ? data.hourly.precipitation_probability.slice(0, 6)
    : [];
  const wind = Array.isArray(data.hourly.wind_speed_10m) ? data.hourly.wind_speed_10m.slice(0, 6) : [];
  const rainProb = precipitation.length ? Math.max(...precipitation) : 0;
  const maxWind = wind.length ? Math.max(...wind) : 0;
  let warning: string | undefined;
  if (rainProb > 50) warning = 'أمطار متوقعة';
  else if (maxWind > 30) warning = 'رياح قوية';

  return {
    temp: Math.round(Number(data.current.temperature_2m) || 0),
    condition: weatherCodeToCondition(Number(data.current.weather_code)),
    icon: 'Sun',
    warning,
  };
};

const loadQuranPage = async (pageNumber: number): Promise<QuranPage | null> => {
  const cacheKey = `${QURAN_CACHE_PREFIX}${pageNumber}`;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as QuranPage;
      if (parsed?.ayahs?.length) return parsed;
    }
  } catch {
    // Ignore cache errors and re-fetch.
  }

  const url = `${QURAN_PAGE_API}/${pageNumber}/quran-uthmani`;
  const data = await fetchJson<{ data?: { ayahs?: QuranAyah[] } } | null>(url, null, 9000);
  if (!data?.data?.ayahs?.length) return null;

  const page: QuranPage = { page: pageNumber, ayahs: data.data.ayahs };
  try {
    localStorage.setItem(cacheKey, JSON.stringify(page));
  } catch {
    // Storage may be full, ignore.
  }
  return page;
};

const groupAyahsBySurah = (ayahs: QuranAyah[]) => {
  const groups: { surah: QuranAyah['surah']; ayahs: QuranAyah[] }[] = [];
  for (const ayah of ayahs) {
    const last = groups[groups.length - 1];
    if (last && last.surah.number === ayah.surah.number) {
      last.ayahs.push(ayah);
    } else {
      groups.push({ surah: ayah.surah, ayahs: [ayah] });
    }
  }
  return groups;
};

// Headlines come from the TV app (NewsFetcher): it reads data/news_sources.json and fetches every feed
// directly, skipping the ones that fail. rss2json.com (used before) answers 403 to every request since 2026-10.
const loadNews = async (sources: NewsSource[], limitPerSource: number) => {
  if (!Array.isArray(sources) || sources.length === 0) return DEFAULT_NEWS;
  const data = await fetchJson<{ items?: { title?: string; source?: string }[] } | null>(
    `/api/hub/news?limit=${limitPerSource}`, null, 20000);
  const items = (data?.items ?? [])
    .filter((item) => item.title?.trim())
    .map((item) => `${item.title!.trim()} (${item.source ?? ''})`);
  return items.length ? items : DEFAULT_NEWS;
};

const isFocusableVisible = (element: HTMLElement) => {
  if (element.hasAttribute('disabled') || element.getAttribute('aria-hidden') === 'true') return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
};

const getFocusScope = (): ParentNode => {
  const traps = document.querySelectorAll<HTMLElement>('[data-focus-trap="true"]');
  return traps.length ? traps[traps.length - 1] : document;
};

const getFocusableElements = () =>
  Array.from(getFocusScope().querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusableVisible);

// Virtual focus on the TV (tv-lite): the browser focus does not move and the highlighted element is not restyled;
// a single floating frame (.tv-focus-ring) is placed over it. On the TCL TV both moving the real DOM focus and
// restyling a card cost 3-4 frames of 100-200 ms per arrow press (jitter); moving the frame cost none
// (DECISIONS H-014). Text fields still take the real focus (they need the keyboard), and any real focus set by
// other code wins over the virtual one. The .tv-focus class only marks the element (no styles).
const VIRTUAL_FOCUS_CLASS = 'tv-focus';
// ring 2px wide, 1px outside the element, so it hugs the element's own 1px border (UX-AUDIT A3; the owner found
// 3px + 2px too wide). The element itself is never restyled.
const RING_GAP = 1;
let virtualActive: HTMLElement | null = null;
let ring: HTMLDivElement | null = null;
let ringBox = '';
const useVirtualFocus = () => document.documentElement.classList.contains('tv-lite');

const placeRing = () => {
  const el = virtualActive;
  if (!el || !el.isConnected) {
    if (ring && ringBox !== 'none') { ring.style.display = 'none'; ringBox = 'none'; }
    return;
  }
  if (!ring) {
    ring = document.createElement('div');
    ring.className = 'tv-focus-ring';
    document.body.appendChild(ring);
  }
  // Same shape as the element (UX-AUDIT A3): exact edges snapped to device pixels so the gap is even on all sides,
  // and the element's own corner radius + the gap, so the curves are parallel.
  const r = el.getBoundingClientRect();
  const px = 1 / (window.devicePixelRatio || 1);
  const snap = (v: number) => Math.round(v / px) * px;
  const left = snap(r.left - RING_GAP), top = snap(r.top - RING_GAP);
  const right = snap(r.right + RING_GAP), bottom = snap(r.bottom + RING_GAP);
  const radius = (parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) + RING_GAP;
  const box = `${left},${top},${right - left},${bottom - top},${radius}`;
  if (box === ringBox) return;                      // unchanged: touch nothing (no repaint)
  ringBox = box;
  Object.assign(ring.style, { display: 'block', left: `${left}px`, top: `${top}px`, width: `${right - left}px`,
    height: `${bottom - top}px`, borderRadius: `${radius}px` });
};

// follow layout changes (tab switch, dialogs, scrolling lists) without per-frame work
if (typeof window !== 'undefined') {
  window.setInterval(() => {
    if (virtualActive || ringBox !== 'none') placeRing();
    // nothing selected (e.g. the focused "back" button of a closed tab was removed): select the first element
    if (useVirtualFocus() && !document.hidden && !getActiveElement()) focusFallback();
  }, 300);
  window.addEventListener('resize', placeRing);
  document.addEventListener('scroll', placeRing, true);
}

const isTextFieldElement = (el: Element | null) => {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el instanceof HTMLInputElement && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file'].includes(el.type);
};

const setVirtual = (el: HTMLElement | null) => {
  // a button that still holds the real focus (autoFocus, a click) keeps its :focus glow: a second highlight that
  // looked like the cursor was stuck on it (lock keypad, digit 1). Only one highlight: the ring.
  const real = document.activeElement;
  if (el && real instanceof HTMLElement && real !== el && real !== document.body && !isTextFieldElement(real)) real.blur();
  if (virtualActive && virtualActive !== el) virtualActive.classList.remove(VIRTUAL_FOCUS_CLASS);
  virtualActive = el;
  if (el) el.classList.add(VIRTUAL_FOCUS_CLASS);
  placeRing();
};

/** The element the remote is on: the virtual one if still shown, otherwise the real focus. */
const getActiveElement = (): HTMLElement | null => {
  const v = virtualActive;
  if (v && v.isConnected && isFocusableVisible(v) && getFocusScope().contains(v)) return v;
  if (v) setVirtual(null);
  // only a real, visible control counts (after Back the WebView may focus the page container itself)
  const a = document.activeElement;
  return a instanceof HTMLElement && a.matches(FOCUSABLE_SELECTOR) && isFocusableVisible(a)
    && a.getAttribute('data-scroll-area') !== 'true' ? a : null;
};

const focusElement = (element: HTMLElement) => {
  if (useVirtualFocus() && !isTextFieldElement(element)) {
    // leave a text field (and its keyboard) when moving away from it
    if (isTextFieldElement(document.activeElement)) (document.activeElement as HTMLElement).blur();
    setVirtual(element);
  } else {
    setVirtual(null);
    element.focus({ preventScroll: true });
  }
  element.scrollIntoView({ block: 'nearest', inline: 'center' });
  placeRing();                                      // after a possible scroll
};

// The element OK was pressed on: when the layer it opened closes, the highlight goes back to it (UX-AUDIT A6).
let layerOpener: HTMLElement | null = null;

/** Highlight the opener of the layer that just closed, or else the first element. */
const focusFallback = () => {
  const back = layerOpener;
  if (back && back.isConnected && isFocusableVisible(back) && getFocusScope().contains(back)) { focusElement(back); return; }
  const first = getFocusableElements()[0];
  if (first) focusElement(first);
};

// Real focus set elsewhere (a dialog focusing its first field, a click) takes over from the virtual one.
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    if (virtualActive && e.target !== virtualActive) setVirtual(null);
  });
}

const findScrollableInDirection = (
  start: HTMLElement | null,
  direction: 'up' | 'down',
): HTMLElement | null => {
  const wantsDown = direction === 'down';
  let curr: HTMLElement | null = start;
  while (curr) {
    const style = window.getComputedStyle(curr);
    if (/(auto|scroll)/.test(style.overflowY) && curr.scrollHeight > curr.clientHeight + 4) {
      const atTop = curr.scrollTop <= 0;
      const atBottom = curr.scrollTop + curr.clientHeight >= curr.scrollHeight - 4;
      if (wantsDown ? !atBottom : !atTop) return curr;
    }
    curr = curr.parentElement;
  }

  const scope = getFocusScope();
  const root = scope === document ? document.body : (scope as HTMLElement);
  const candidates = root.querySelectorAll<HTMLElement>('[data-scroll-area="true"], [class*="overflow-y"]');
  for (const el of Array.from(candidates)) {
    if (el.scrollHeight > el.clientHeight + 4) {
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      if (wantsDown ? !atBottom : !atTop) return el;
    }
  }
  return null;
};

const moveFocus = (direction: 'up' | 'down' | 'left' | 'right') => {
  const elements = getFocusableElements();

  const current = getActiveElement();
  const active = current && elements.includes(current) ? current : null;

  if (elements.length > 0 && !active) {
    focusElement(elements[0]);
    return;
  }

  if (!active) return;

  const activeRect = active.getBoundingClientRect();
  const activeCenter = {
    x: activeRect.left + activeRect.width / 2,
    y: activeRect.top + activeRect.height / 2,
  };

  const PRIMARY_THRESHOLD = 24;
  const SECONDARY_PENALTY = 5;

  const scored = elements
    .filter((element) => element !== active)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const dx = center.x - activeCenter.x;
      const dy = center.y - activeCenter.y;
      const primary =
        direction === 'right' ? dx :
        direction === 'left' ? -dx :
        direction === 'down' ? dy :
        -dy;
      // sideways distance to the element's EDGE, not its centre: a wide box straight below/above (reminders) counts
      // as aligned, instead of losing to a narrower tile further away (AUDIT-3 U3)
      const secondary = direction === 'left' || direction === 'right'
        ? Math.max(0, rect.top - activeCenter.y, activeCenter.y - rect.bottom)
        : Math.max(0, rect.left - activeCenter.x, activeCenter.x - rect.right);
      return {
        element,
        primary,
        score: primary * primary + secondary * secondary * SECONDARY_PENALTY,
      };
    })
    .filter((item) => item.primary > PRIMARY_THRESHOLD)
    .sort((a, b) => a.score - b.score);

  if (scored[0]) {
    focusElement(scored[0].element);
    return;
  }

  if (direction === 'up' || direction === 'down') {
    const container = findScrollableInDirection(active, direction);
    if (container) {
      container.scrollBy({ top: direction === 'down' ? 240 : -240, behavior: 'smooth' });
    }
  }
};

// --- Components ---

const DigitalClock = ({ timeZone }: { timeZone: string }) => {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (date: Date) => {
    // Latin digits with Arabic ص / م (UX-AUDIT A8)
    return date.toLocaleTimeString('en-US', {
      hour12: true,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone
    }).replace(/\s?AM$/i, ' ص').replace(/\s?PM$/i, ' م');
  };

  const formatDate = (date: Date) => {
    const gregorian = date.toLocaleDateString('ar-SA', { 
      weekday: 'long', 
      day: 'numeric', 
      month: 'long', 
      year: 'numeric',
      timeZone 
    });
    const hijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone
    }).format(date);
    
    return { gregorian, hijri };
  };

  const dates = formatDate(time);

  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="flex items-center gap-2 text-3xl font-bold text-white drop-shadow-lg">
        <Clock className="w-7 h-7 text-blue-400" />
        <span dir="ltr">{formatTime(time)}</span>
      </div>
      <div className="flex flex-col items-center text-sm text-blue-100/80">
        <span>{dates.gregorian}</span>
        <span className="font-semibold text-yellow-400/90">{dates.hijri}</span>
      </div>
    </div>
  );
};

const PrayerCard = ({ 
  name, 
  time, 
  isActive, 
  countdown,
  imminent 
}: { 
  name: string; 
  time: string; 
  isActive: boolean;
  countdown: string | null;
  imminent?: boolean;
}) => (
  <motion.div 
    className={`relative flex flex-col items-center justify-center p-2 py-3 h-full min-h-[5rem] w-full mx-auto rounded-2xl border transition-all duration-500 overflow-hidden ${
      isActive 
        ? 'bg-blue-500/20 border-blue-400/50 shadow-[0_0_24px_rgba(59,130,246,0.2)] scale-[1.02] z-10' 
        : imminent
        ? 'bg-red-500/20 border-red-400/50 shadow-[0_0_20px_rgba(239,68,68,0.2)] animate-pulse'
        : 'bg-white/[0.03] border-white/5 hover:bg-white/10'
    }`}
    initial={false}
  >
    {(isActive || imminent) && (
      // CSS animation (index.css .prayer-glow): runs on the compositor; a JS-driven loop redrew the page every frame
      <div className={`prayer-glow absolute inset-0 ${isActive ? 'bg-blue-400/10' : 'bg-red-400/10'}`} />
    )}
    <span className={`text-xl font-bold mb-1 ${isActive ? 'text-blue-300' : 'text-zinc-400'}`}>{name}</span>
    <span className={`text-4xl font-black leading-none ${isActive ? 'text-white' : 'text-zinc-200'}`} dir="ltr">{time}</span>
    {countdown && (
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[0.65rem] uppercase text-blue-300/80">متبقي</span>
        <span className="text-sm font-mono text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-full" dir="ltr">{countdown}</span>
      </div>
    )}
  </motion.div>
);


const QUICK_ICON_MAP: Record<string, { Icon: React.ComponentType<{ className?: string }>; color: string }> = {
  youtube:   { Icon: Youtube,   color: 'text-red-500' },
  shahid:    { Icon: Tv,        color: 'text-blue-400' },
  aljazeera: { Icon: Newspaper, color: 'text-orange-400' },
  playstore: { Icon: Store,     color: 'text-emerald-400' },
  google:    { Icon: Search,    color: 'text-sky-300' },
  matches:   { Icon: Trophy,    color: 'text-yellow-400' },
  default:   { Icon: AppWindow, color: 'text-zinc-400' },
};

const QuickLinkIcon = ({ link }: { link: QuickLink }) => {
  // نعتبر الحقل صورةً إن كان iconUrl موجوداً، أو إن كان icon مساراً/رابطاً
  // (يبدأ بـ / أو http) — هذا يصلح البيانات القديمة التي تضع مسار الصورة في icon.
  const isImagePath = (v?: string) => !!v && (v.startsWith('/') || v.startsWith('http') || v.startsWith('data:'));
  const imgSrc = link.iconUrl || (isImagePath(link.icon) ? link.icon : '');
  if (imgSrc) {
    return (
      <img
        src={imgSrc}
        alt=""
        className="w-12 h-12 object-contain"
        loading="lazy"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  const entry = QUICK_ICON_MAP[link.icon] || QUICK_ICON_MAP.default;
  const { Icon, color } = entry;
  return <Icon className={`w-9 h-9 ${color}`} />;
};

const NewsTicker = ({ items, accent }: { items: string[]; accent: 'rose' | 'emerald' }) => {
  const [width, setWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      setWidth(containerRef.current.scrollWidth);
    }
  }, [items]);

  const duration = Math.max(width / 40, 50);
  const accentBorder = accent === 'rose' ? 'border-rose-500/20' : 'border-emerald-500/20';

  return (
    <div className="w-full overflow-hidden">
      <div
        className={`news-ticker-container relative h-14 bg-black/30 backdrop-blur-md flex items-center border-y ${accentBorder} overflow-hidden`}
      >
        {/* CSS animation (index.css .ticker-run): the GPU moves the strip; the JS-driven version kept the
            main thread busy every frame and made remote navigation lag on 2GB TVs (DECISIONS H-008) */}
        <div
          ref={containerRef}
          className="ticker-run flex whitespace-nowrap gap-16 px-12"
          style={{ '--ticker-w': `${width}px`, animationDuration: `${duration}s` } as React.CSSProperties}
        >
          {items.map((item, i) => (
            <span key={i} className="text-2xl font-medium text-zinc-100">
              {item}
            </span>
          ))}
          {items.map((item, i) => (
            <span key={`dup-${i}`} className="text-2xl font-medium text-zinc-100">
              {item}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default function Dashboard() {
  const [config, setConfig] = useState<Config | null>(null);
  const [prayers, setPrayers] = useState<PrayerTimes | null>(null);
  const [nextPrayer, setNextPrayer] = useState<{ name: string; time: Date } | null>(null);
  const [countdown, setCountdown] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [motd, setMotd] = useState<string>('');
  const [news, setNews] = useState<string[]>([]);
  // phone admin link shown where the owner has to act from the phone (UX-AUDIT A7)
  const [adminLink, setAdminLink] = useState('');
  // Wi-Fi icon: green with internet, grey without (the app reads Android's network state)
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const check = () => fetchJson<{ lan?: string; online?: boolean }>('/api/hub/ping', {}, 4000).then((p) => {
      if (p.lan) setAdminLink(`http://${p.lan}:8080`);
      if (typeof p.online === 'boolean') setOnline(p.online);
    });
    check();
    const t = window.setInterval(check, 20000);
    return () => window.clearInterval(t);
  }, []);
  const [adhkar, setAdhkar] = useState<string[]>([]);
  // kept in localStorage so a page reload (freeze watchdog, renderer restart, owner panel) does not unlock (AUDIT L10)
  const [isLocked, setIsLockedState] = useState(() => {
    try { return localStorage.getItem('dashboard_locked') === '1'; } catch { return false; }
  });
  const setIsLocked = useCallback((v: boolean) => {
    setIsLockedState(v);
    try { if (v) localStorage.setItem('dashboard_locked', '1'); else localStorage.removeItem('dashboard_locked'); } catch { /* ignore */ }
  }, []);
  const [pinEntry, setPinEntry] = useState('');
  const [pinError, setPinError] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'quran' | 'photo_viewer'>('dashboard');
  const [showWifi, setShowWifi] = useState(false);
  const [showMeal, setShowMeal] = useState(false);
  const [showAllReminders, setShowAllReminders] = useState(false);   // all of today's reminders (AUDIT-3 U3)
  const [randomMeal, setRandomMeal] = useState('');
  const [dailyImage, setDailyImage] = useState<string | null>(null);
  const [wifiInfo, setWifiInfo] = useState<WifiInfo>({ ssid: '', password: '' });
  const [quranPage, setQuranPage] = useState<QuranPage | null>(null);
  const [quranLoading, setQuranLoading] = useState(false);
  const [quranError, setQuranError] = useState<string | null>(null);
  const [isIdle, setIsIdle] = useState(false);
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isTv = isTvDevice();
  const [dataError, setDataError] = useState(false);

  // --- Initialization ---

  const [quickLinks, setQuickLinks] = useState<QuickLink[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const lastUsedRef = useRef<Record<string, number>>({});

  // --- Initialization ---

  const loadAllData = useCallback(async () => {
    try {
      const configData = await fetchJson<Config | null>('/config.json', null, 4000);
      if (!configData) throw new Error('Missing config.json');
      setConfig(configData);
      setDataError(false);

      const [motdData, qlData, mealsData, adhkarData, imgData, sources, wifiData, remindersData] = await Promise.all([
        fetchJson<MotdResponse>('/data/motd.json', { messages: [] }),
        fetchJson<QuickLink[]>('/data/quicklinks.json', []),
        fetchJson<MealsResponse>('/data/meals.json', { meals: [] }),
        fetchJson<AdhkarResponse>('/data/adhkar.json', { morning: [], evening: [] }),
        fetchJson<ImagesResponse>('/data/images.json', { images: [] }),
        fetchJson<NewsSource[]>('/data/news_sources.json', []),
        fetchJson<WifiInfo>('/data/wifi.json', { ssid: '', password: '' }),
        fetchJson<RemindersResponse>('/data/reminders.json', { reminders: [] }),
      ]);

      const dateKey = getDateKey(configData.userSettings.location.timeZone);
      setMotd(pickDailyItem(DAILY_MOTD_KEY, dateKey, motdData.messages, ''));
      setWifiInfo(wifiData);

      const mru = safeParseObject(localStorage.getItem('mru_links'));
      lastUsedRef.current = mru;
      // apps uninstalled or disabled since they were added are not shown (the TV app also removes them from the file)
      const installed = window.tvHub ? await fetchJson<{ pkg: string }[] | null>('/api/hub/apps', null, 4000) : null;
      const have = installed && installed.length ? new Set(installed.map((a) => a.pkg)) : null;
      const visibleLinks = have ? qlData.filter((l) => l.type !== 'app' || !l.pkg || have.has(l.pkg)) : qlData;
      const sortedLinks = [...visibleLinks].sort((a, b) => (mru[b.label] || 0) - (mru[a.label] || 0));
      setQuickLinks(sortedLinks);

      setRandomMeal(pickDailyItem(DAILY_MEAL_KEY, dateKey, mealsData.meals, DEFAULT_MEAL));

      // Reminders: data/reminders.json (phone admin) is the only source, the same file the TV's alarms use.
      // An empty list means no reminders (the old defaults showed reminders that never rang, AUDIT-3 L1).
      setReminders(Array.isArray(remindersData.reminders) ? remindersData.reminders : []);

      const localHour = parseInt(
        new Intl.DateTimeFormat('en-US', {
          timeZone: configData.userSettings.location.timeZone,
          hour: '2-digit',
          hour12: false,
        }).format(new Date()),
        10,
      );
      const isMorning = !Number.isNaN(localHour) && localHour < 12;
      setAdhkar(isMorning ? adhkarData.morning : adhkarData.evening);
      setDailyImage(pickDailyItem(DAILY_IMAGE_KEY, dateKey, imgData.images, '') || null);

      const [prayerData, weatherData, newsItems] = await Promise.all([
        loadPrayerTimes(configData),
        loadWeather(configData),
        loadNews(sources, configData.appConfig.news.limitPerSource || 5),
      ]);
      if (prayerData) setPrayers(prayerData);
      if (weatherData) setWeather(weatherData);
      setNews(newsItems);

    } catch (e) {
      console.error("Data loading error", e);
      // نُظهر شاشة "غير متصل" فقط عند فشل تحميل الإعدادات الأساسية أول مرة،
      // حتى لا تبقى الشاشة فارغة. التحديثات اللاحقة تحتفظ بآخر بيانات ناجحة.
      setConfig((prev) => {
        if (!prev) setDataError(true);
        return prev;
      });
    }
  }, []);

  useEffect(() => {
    loadAllData();
    const interval = setInterval(loadAllData, 10 * 60 * 1000); // 10 min refresh
    return () => clearInterval(interval);
  }, [loadAllData]);

  // إعادة المحاولة تلقائياً عند عودة الاتصال بالشبكة.
  useEffect(() => {
    const onOnline = () => loadAllData();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [loadAllData]);

  // مؤقّت مراقبة (Watchdog): يكشف تجمّد الواجهة عبر فجوة زمنية غير متوقعة
  // بين النبضات، ثم يعيد التحميل — لكن *فقط* حين تكون لوحتنا هي المرئية في المقدمة.
  // بذلك لا نُغلق أي تطبيق آخر يشغّله المستخدم (مثل يوتيوب) لأن لوحتنا حينها مخفية.
  useEffect(() => {
    const HEARTBEAT_MS = 5000;
    const FREEZE_LIMIT_MS = 90000; // فجوة تتجاوز هذا الحد تعني تجمّداً فعلياً
    let last = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      const gap = now - last;
      last = now;
      if (gap > FREEZE_LIMIT_MS && document.visibilityState === 'visible') {
        console.warn(`Watchdog: تجمّد محتمل (${gap}ms) — إعادة تحميل الواجهة`);
        window.location.reload();
      }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, []);

  // عند عودة اللوحة للمقدمة (رجوع المستخدم من تطبيق آخر) نُحدّث البيانات
  // بلا إعادة تحميل كامل، لتفادي أي وميض أو مقاطعة.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadAllData();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadAllData]);

  // على التلفزيون فقط: نُعدّد التطبيقات المثبّتة عبر واجهة Fully ونكتبها في
  // data/installed_apps.json ليقرأها الهاتف في لوحة الإدارة ويختار منها.
  // نكتب فقط عند تغيّر القائمة لتقليل عمليات الكتابة على السيرفر.
  useEffect(() => {
    // TV Hub: the phone admin reads the installed apps straight from the TV (/api/apps), nothing to upload.
    if (!isTv || window.tvHub) return;
    const apps = readInstalledAppsFromFully();
    if (!apps || apps.length === 0) return;
    (async () => {
      try {
        const existing = await fetchJson<{ apps?: { pkg: string }[] }>('/data/installed_apps.json', { apps: [] });
        const prevKey = JSON.stringify((existing.apps || []).map((a) => a.pkg).sort());
        const nextKey = JSON.stringify(apps.map((a) => a.pkg).sort());
        if (prevKey === nextKey) return;
        await putJsonFile('/data', 'installed_apps.json', { apps, updatedAt: new Date().toISOString() });
      } catch (e) {
        console.warn('تعذّر تحديث قائمة التطبيقات المثبّتة', e);
      }
    })();
  }, [isTv]);

  // Schedule a refresh exactly at the next local-midnight (timeZone-aware)
  // so the daily meal / image / quran page roll over without manual reload.
  useEffect(() => {
    if (!config) return;
    const timeZone = config.userSettings.location.timeZone || 'Asia/Riyadh';
    let timer: number | undefined;

    const scheduleNext = () => {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
      const parts = formatter.formatToParts(new Date());
      const get = (type: string) => parts.find((p) => p.type === type)?.value || '0';
      const todayMidnightLocalIsoUtc = new Date(
        `${get('year')}-${get('month')}-${get('day')}T00:00:00`,
      );
      const offsetMs = Date.now() - new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`).getTime();
      const nextMidnightUtc = todayMidnightLocalIsoUtc.getTime() + offsetMs + 24 * 3600 * 1000 + 5_000;
      const delay = Math.max(60_000, nextMidnightUtc - Date.now());
      timer = window.setTimeout(() => {
        loadAllData();
        scheduleNext();
      }, delay);
    };

    scheduleNext();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [config, loadAllData]);

  const lastNotifiedRef = useRef<Record<string, 'imminent' | 'started' | null>>({});

  const playNotification = useCallback(() => {
    try {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) return;
      const audioContext = new AudioContextCtor();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
      gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.25, audioContext.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.45);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.5);
    } catch (e) {
      console.error('Audio error', e);
    }
  }, []);

  // Reminder alerts are shown by the app itself (Reminders.java): a banner over ANY app at the reminder time,
  // for the duration set on the phone. The page no longer shows its own, which only worked while it was on screen.

  // --- Countdown Logic ---
  useEffect(() => {
    if (!prayers) return;

    const updateCountdown = () => {
      const now = new Date();
      const toDate = (timeStr: string) => {
        const [h, m] = timeStr.split(':').map(Number);
        const d = new Date();
        d.setHours(h, m, 0, 0);
        return d;
      };

      const prayerOrder = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
      let next = null;

      for (const name of prayerOrder) {
        const time = toDate(prayers[name as keyof PrayerTimes]);
        if (time > now) {
          next = { name, time };
          break;
        }
      }

      if (!next) {
        const time = toDate(prayers.Fajr);
        time.setDate(time.getDate() + 1);
        next = { name: 'Fajr', time };
      }

      setNextPrayer(next);

      const diff = next.time.getTime() - now.getTime();
      
      // Sound Notification Logic
      const prayerId = `${next.name}-${next.time.getTime()}`;

      // 5 minutes before
      if (diff > 299000 && diff < 301000) {
        if (lastNotifiedRef.current[prayerId] !== 'imminent') {
          playNotification();
          lastNotifiedRef.current[prayerId] = 'imminent';
        }
      }
      // At start
      if (diff > -1000 && diff < 1000) {
        if (lastNotifiedRef.current[prayerId] !== 'started') {
          playNotification();
          lastNotifiedRef.current[prayerId] = 'started';
        }
      }

      // Forget notifications older than 24h to avoid unbounded growth.
      const cutoff = now.getTime() - 24 * 3600 * 1000;
      const entries = Object.keys(lastNotifiedRef.current);
      if (entries.length > 32) {
        for (const key of entries) {
          const ts = parseInt(key.split('-').pop() || '0', 10);
          if (ts && ts < cutoff) delete lastNotifiedRef.current[key];
        }
      }

      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
    };

    const timer = setInterval(updateCountdown, 1000);
    updateCountdown();
    return () => clearInterval(timer);
  }, [prayers, playNotification]);

  // Mark body so global CSS knows we are on the dashboard (overflow lock).
  useEffect(() => {
    document.body.dataset.page = 'dashboard';
    return () => {
      delete document.body.dataset.page;
    };
  }, []);

  // --- Idle Timer ---
  const resetIdleTimer = useCallback(() => {
    setIsIdle(false);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setIsIdle(true), 5 * 60 * 1000);
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', resetIdleTimer);
    window.addEventListener('pointerdown', resetIdleTimer);
    resetIdleTimer();
    return () => {
      window.removeEventListener('keydown', resetIdleTimer);
      window.removeEventListener('pointerdown', resetIdleTimer);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [resetIdleTimer]);

  // --- Navigation & PIN ---
  const checkLockPin = useCallback((entry: string) => {
    if (entry === (config?.userSettings.security.pinCode || '1234')) {
      setIsLocked(false);
      setPinEntry('');
      setPinError(false);
    } else {
      setPinError(true);
      setPinEntry('');
    }
  }, [config]);

  // Lock screen keypad (UX-AUDIT A2): on-screen digits instead of a text field, so the system keyboard never
  // opens. The 4th digit submits. The remote's number keys work too.
  const pressLockKey = useCallback((k: string) => {
    if (k === 'del') { setPinEntry((p) => p.slice(0, -1)); return; }
    setPinError(false);
    setPinEntry((p) => {
      const next = (p + k).slice(0, 4);
      if (next.length === 4) window.setTimeout(() => checkLockPin(next), 120);
      return next;
    });
  }, [checkLockPin]);

  useEffect(() => {
    if (!isLocked) return;
    const onDigit = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pressLockKey(e.key); }
    };
    window.addEventListener('keydown', onDigit);
    return () => window.removeEventListener('keydown', onDigit);
  }, [isLocked, pressLockKey]);

  // reminders as tiles: the next ones of today first (the very next marked), then those already passed today;
  // recomputed each minute with the clock tick below
  const [reminderNow, setReminderNow] = useState(() => Date.now());
  useEffect(() => {
    // every minute: re-order the tiles, and pick up changes made on the phone (AUDIT-3 L2)
    const t = window.setInterval(() => {
      setReminderNow(Date.now());
      fetchJson<RemindersResponse | null>('/data/reminders.json', null, 4000).then((r) => {
        if (r && Array.isArray(r.reminders)) {
          setReminders((cur) => (JSON.stringify(cur) === JSON.stringify(r.reminders) ? cur : r.reminders));
        }
      });
    }, 60000);
    return () => window.clearInterval(t);
  }, []);
  const reminderTiles = useMemo(() => {
    const tz = config?.userSettings.location.timeZone;
    const nowHM = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
      .format(new Date(reminderNow));
    // only today's reminders (week days chosen on the phone)
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      .indexOf(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(reminderNow)));
    const sorted = reminders
      .filter((r) => !r.days || r.days.length === 0 || r.days.includes(weekday))
      .sort((a, b) => a.time.localeCompare(b.time));
    const upcoming = sorted.filter((r) => r.time >= nowHM);
    const passed = sorted.filter((r) => r.time < nowHM);
    return [
      ...upcoming.map((r, i) => ({ ...r, next: i === 0, passed: false })),
      ...passed.map((r) => ({ ...r, next: false, passed: true })),
    ];
  }, [reminders, reminderNow, config]);

  const handleLaunch = (link: QuickLink) => {
    const updatedMru = { ...lastUsedRef.current, [link.label]: Date.now() };
    localStorage.setItem('mru_links', JSON.stringify(updatedMru));
    lastUsedRef.current = updatedMru;
    
    // Sort logic
    const sorted = [...quickLinks].sort((a, b) => (updatedMru[b.label] || 0) - (updatedMru[a.label] || 0));
    setQuickLinks(sorted);

    // only http(s) links: a javascript:/data: link would run inside this page (AUDIT S3)
    const webUrl = link.url && /^https?:\/\//i.test(link.url) ? link.url : '';
    if (window.fully) {
      if (link.type === 'app' && link.pkg) {
        window.fully.startApplication?.(link.pkg);
      } else if (webUrl) {
        window.fully.loadUrl?.(webUrl);
      }
    } else if (webUrl) {
      window.open(webUrl, '_blank', 'noopener');
    }
  };

  const refreshMealSuggestion = useCallback(
    async (openModal = false) => {
      const data = await fetchJson<MealsResponse>('/data/meals.json', { meals: [] }, 4000);
      const dateKey = getDateKey(config?.userSettings.location.timeZone);
      setRandomMeal(pickDailyItem(DAILY_MEAL_KEY, dateKey, data.meals, DEFAULT_MEAL));
      if (openModal) setShowMeal(true);
    },
    [config],
  );

  const pickAnotherMeal = useCallback(async () => {
    const data = await fetchJson<MealsResponse>('/data/meals.json', { meals: [] }, 4000);
    if (!data.meals?.length) return;
    const dateKey = getDateKey(config?.userSettings.location.timeZone);
    const others = data.meals.filter((m) => m !== randomMeal);
    const pool = others.length > 0 ? others : data.meals;
    const next = pool[Math.floor(Math.random() * pool.length)] || data.meals[0];
    setRandomMeal(next);
    try {
      localStorage.setItem(DAILY_MEAL_KEY, JSON.stringify({ date: dateKey, value: next }));
    } catch {
      // localStorage may be unavailable; the in-memory pick still updates.
    }
  }, [config, randomMeal]);

  const refreshDailyImage = useCallback(async () => {
    const data = await fetchJson<ImagesResponse>('/data/images.json', { images: [] }, 4000);
    const dateKey = getDateKey(config?.userSettings.location.timeZone);
    setDailyImage(pickDailyItem(DAILY_IMAGE_KEY, dateKey, data.images, '') || null);
  }, [config]);

  const closeTopLayer = useCallback(() => {
    if (showAllReminders) {
      setShowAllReminders(false);
      return true;
    }
    if (showWifi) {
      setShowWifi(false);
      return true;
    }
    if (showMeal) {
      setShowMeal(false);
      return true;
    }
    if (activeTab !== 'dashboard') {
      setActiveTab('dashboard');
      return true;
    }
    // The lock screen is NOT a layer Back may close: it opens with the PIN only (AUDIT L1).
    return false;
  }, [activeTab, showMeal, showWifi, showAllReminders]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const active = getActiveElement();
      if (active && isFocusableVisible(active) && getFocusScope().contains(active)) return;
      focusFallback();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [activeTab, isLocked, showMeal, showWifi, showAllReminders, quickLinks.length]);

  useEffect(() => {
    const handleRemoteKey = (event: KeyboardEvent) => {
      const active = getActiveElement();
      const isTextField = isTextFieldElement(active);

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (isTextField && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          return;
        }
        event.preventDefault();
        const direction = event.key.replace('Arrow', '').toLowerCase() as 'up' | 'down' | 'left' | 'right';
        moveFocus(direction);
        return;
      }

      if (['Enter', 'NumpadEnter'].includes(event.key)) {
        if (isTextField) return;
        if (active && isFocusableVisible(active)) {
          event.preventDefault();
          layerOpener = active;
          active.click();
        }
        return;
      }

      if (event.key === ' ' && !isTextField) {
        if (active && isFocusableVisible(active)) {
          event.preventDefault();
          layerOpener = active;
          active.click();
        }
        return;
      }

      // زر الرجوع: يشمل مفاتيح المتصفح والريموت وزر BACK في أندرويد (keyCode 4).
      const isBackKey =
        ['Escape', 'Backspace', 'BrowserBack', 'GoBack'].includes(event.key) ||
        event.keyCode === 4;
      if (isBackKey) {
        // داخل حقل نصّي نترك Backspace يحذف الأحرف بشكل طبيعي.
        if (isTextField && event.key === 'Backspace') return;
        // أغلق أعلى طبقة مفتوحة (نافذة/تبويب/قفل) وارجع خطوة نحو الشاشة الرئيسية.
        if (closeTopLayer()) {
          event.preventDefault();
          return;
        }
        // إن كنا على مسار غير الرئيسية (مثل #/admin) أعد التوجيه للرئيسية.
        if (window.location.hash && window.location.hash !== '#/' && window.location.hash !== '#') {
          event.preventDefault();
          window.location.hash = '#/';
          return;
        }
        // على الشاشة الرئيسية النظيفة نمنع خروج Fully Kiosk بضغطة رجوع عرضية.
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', handleRemoteKey, true);
    return () => window.removeEventListener('keydown', handleRemoteKey, true);
  }, [closeTopLayer]);

  const getQuranPage = useCallback(() => {
    if (!config) return 1;
    const start = new Date(config.userSettings.quran.startDate);
    if (Number.isNaN(start.getTime())) return 1;
    const today = new Date();
    const diffDays = Math.floor((today.getTime() - start.getTime()) / (1000 * 3600 * 24));
    const normalized = ((diffDays % 604) + 604) % 604;
    return normalized + 1;
  }, [config]);

  const fetchCurrentQuranPage = useCallback(async () => {
    const page = getQuranPage();
    setQuranLoading(true);
    setQuranError(null);
    try {
      const data = await loadQuranPage(page);
      if (!data) {
        setQuranError('تعذر تحميل صفحة القرآن. تحقق من الاتصال بالإنترنت ثم أعد المحاولة.');
        return;
      }
      setQuranPage(data);
    } finally {
      setQuranLoading(false);
    }
  }, [getQuranPage]);

  useEffect(() => {
    if (activeTab !== 'quran' || !config) return;
    const expected = getQuranPage();
    if (quranPage?.page === expected) return;
    fetchCurrentQuranPage();
  }, [activeTab, config, getQuranPage, quranPage?.page, fetchCurrentQuranPage]);

  // شاشة "غير متصل" المهذّبة: تظهر فقط إن فشل تحميل الإعدادات الأساسية أول مرة
  // (لا توجد بيانات سابقة). زر إعادة المحاولة قابل للتركيز والتفعيل بالريموت.
  if (dataError && !config) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050505] font-sans p-8" data-focus-trap="true">
        <div className="w-full max-w-lg p-10 bg-white/[0.02] rounded-[3rem] border border-white/5 shadow-2xl text-center backdrop-blur-3xl">
          <div className="bg-red-500/10 w-24 h-24 mx-auto rounded-full flex items-center justify-center mb-8 border border-red-500/20">
            <WifiOff className="w-12 h-12 text-red-400" />
          </div>
          <h1 className="text-4xl font-bold mb-4 tracking-tight text-zinc-100">تعذّر الاتصال بالسيرفر</h1>
          <p className="text-zinc-400 text-lg mb-10 leading-8">
            تأكد أن Simple HTTP Server يعمل على التلفزيون وأن الجهاز متصل بالشبكة، ثم أعد المحاولة.
          </p>
          <button
            autoFocus
            onClick={() => loadAllData()}
            className="inline-flex items-center gap-3 px-8 py-4 bg-blue-600 hover:bg-blue-500 rounded-2xl font-bold text-xl transition-all shadow-lg focus:outline-none"
          >
            <RefreshCw className="w-6 h-6" />
            إعادة المحاولة
          </button>
          <p className="mt-8 text-zinc-600 text-xs font-mono">v{APP_VERSION}</p>
        </div>
      </div>
    );
  }

  if (isLocked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#050505] font-sans" data-focus-trap="true">
        <div className="w-full max-w-md p-10 bg-white/[0.02] rounded-[3rem] border border-white/5 shadow-2xl text-center backdrop-blur-3xl">
          <div className="bg-blue-500/10 w-24 h-24 mx-auto rounded-full flex items-center justify-center mb-8 border border-blue-500/20">
             <Lock className="w-12 h-12 text-blue-400" />
          </div>
          <h1 className="text-4xl font-bold mb-6 tracking-tight text-zinc-100">شاشة القفل</h1>
          <div
            className={`flex justify-center gap-5 py-4 mb-6 ${pinError ? 'animate-shake' : ''}`}
            dir="ltr"
            aria-label="الرمز"
          >
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={`w-5 h-5 rounded-full border-2 ${pinError ? 'border-red-500' : 'border-zinc-400'} ${i < pinEntry.length ? (pinError ? 'bg-red-500' : 'bg-zinc-100') : ''}`}
              />
            ))}
          </div>
          {pinError && <p className="text-red-400 font-bold mb-4 text-lg">الرمز غير صحيح!</p>}
          <div className="grid grid-cols-3 gap-3 max-w-[18rem] mx-auto" dir="ltr">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0'].map((k) => (
              <button
                key={k}
                onClick={() => pressLockKey(k)}
                className={`h-16 rounded-2xl bg-white/10 text-3xl font-bold text-zinc-100 ${k === 'del' ? 'text-2xl' : ''} ${k === '0' ? 'col-start-2' : ''}`}
                aria-label={k === 'del' ? 'حذف' : k}
              >
                {k === 'del' ? '⌫' : k}
              </button>
            ))}
          </div>
          <p className="mt-8 text-zinc-400 text-base">أدخل الرمز المكون من ٤ أرقام لفتح اللوحة</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative h-screen overflow-hidden bg-transparent text-white font-sans transition-opacity duration-1000 flex flex-col ${isIdle ? 'opacity-20' : 'opacity-100'}`}>
      
      {/* Background elements */}
      {config?.appearance?.backgroundImage ? (
        <>
          <div
            className="fixed inset-0 z-[-2] bg-cover bg-center"
            style={{ backgroundImage: `url(${config.appearance.backgroundImage})` }}
            aria-hidden="true"
          />
          <div
            className="fixed inset-0 z-[-1]"
            style={{ backgroundColor: `rgba(2, 2, 2, ${Math.min(0.95, Math.max(0, config.appearance.backgroundDim ?? 0.55))})` }}
            aria-hidden="true"
          />
        </>
      ) : (
        <div className="fixed inset-0 z-[-1] bg-[#020202]" aria-hidden="true">
          <div className="absolute top-[-20%] right-[10%] w-[50vw] h-[50vw] rounded-full bg-blue-900/20 blur-[120px]" />
          <div className="absolute top-[30%] left-[-10%] w-[40vw] h-[40vw] rounded-full bg-emerald-900/10 blur-[120px]" />
          <div className="absolute bottom-[-20%] right-[20%] w-[60vw] h-[60vw] rounded-full bg-purple-900/10 blur-[120px]" />
        </div>
      )}
      
      {/* --- Header --- */}
      <header className="flex-none flex justify-between items-start p-4 pb-2">
        <div className="flex gap-5 items-center bg-zinc-800/40 backdrop-blur-2xl p-3 px-5 rounded-3xl border border-white/5 shadow-2xl">
          <DigitalClock timeZone={config?.userSettings.location.timeZone || 'Asia/Riyadh'} />
          <div className="w-px h-14 bg-white/10" />
          {weather && (
            <div className="flex items-center gap-4">
              <div className="bg-gradient-to-br from-amber-400/20 to-orange-500/20 p-2 rounded-2xl border border-amber-500/20 shadow-[0_0_20px_rgba(251,191,36,0.1)]">
                <Sun className="w-7 h-7 text-amber-400 drop-shadow-md" />
              </div>
              <div>
                <div className="text-2xl font-light mb-0.5 flex items-start gap-1">
                  {weather.temp}<span className="text-base text-zinc-500 mt-1">°C</span>
                </div>
                <div className="flex items-center gap-2 text-zinc-400 text-sm">
                  <span className="font-medium">{weather.condition}</span>
                  {weather.warning && (
                    <span className="flex items-center gap-1 text-red-400 font-bold bg-red-400/10 px-2 py-1 rounded-full text-xs shadow-[0_0_10px_rgba(248,113,113,0.1)]">
                      <AlertTriangle className="w-4 h-4" />
                      {weather.warning}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-3">
          {/* رابط الإدارة يظهر فقط خارج التلفزيون (على الهاتف/المتصفح) لأن الإدارة
              تتطلب كتابة نصوص غير عملية بالريموت، ولمنع دخول المستخدم إليها بالخطأ. */}
          {!isTv && (
          <a
            href="#/admin"
            className="flex items-center justify-center w-11 h-11 bg-zinc-800/40 hover:bg-white/10 border border-white/5 rounded-2xl transition-all backdrop-blur-xl shadow-lg focus:outline-none"
            title="لوحة الإدارة"
            aria-label="فتح لوحة الإدارة"
          >
            <UserCog className="w-6 h-6 text-blue-300" />
          </a>
          )}
          <button
            onClick={() => setShowWifi(true)}
            className="flex items-center gap-2 px-4 py-3 bg-zinc-800/40 hover:bg-white/10 border border-white/5 rounded-2xl transition-all backdrop-blur-xl shadow-lg focus:outline-none"
          >
            {online ? <Wifi className="w-5 h-5 text-emerald-400" /> : <WifiOff className="w-5 h-5 text-zinc-500" />}
            <span className="text-sm font-medium">Wi-Fi</span>
          </button>
          <button 
            className="flex items-center gap-2 px-4 py-3 bg-zinc-800/40 hover:bg-white/10 border border-white/5 rounded-2xl transition-all backdrop-blur-xl shadow-lg focus:outline-none"
            onClick={() => {
              if (window.fully) {
                window.fully.startApplication?.('com.android.tv.settings');
              }
            }}
          >
            <Settings className="w-5 h-5 text-zinc-400" />
            <span className="text-sm font-medium">الإعدادات</span>
          </button>
          <button 
            onClick={() => setIsLocked(true)}
            className="flex items-center gap-2 px-4 py-3 bg-zinc-800/40 hover:bg-red-500/20 border border-red-500/20 rounded-2xl transition-all text-red-400 backdrop-blur-xl shadow-lg focus:outline-none"
          >
            <Lock className="w-5 h-5" />
            <span className="text-sm font-medium">قفل</span>
          </button>
        </div>
      </header>

      <main className="flex-1 min-h-0 px-4 pb-28 relative z-10 overflow-y-auto scrollbar-hide" data-scroll-area="true">
        <div className="max-w-screen-2xl mx-auto flex flex-col gap-3">

          {/* --- MOTD --- */}
          {/* --- Row A: رسالة اليوم (⅔) + التذكيرات (⅓) --- */}
          <div className="grid grid-cols-3 gap-3 items-stretch">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="col-span-2 p-4 bg-zinc-800/40 backdrop-blur-2xl border border-white/5 rounded-3xl relative overflow-hidden shadow-2xl flex flex-col justify-center min-h-[5rem]"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-blue-500/5 to-purple-500/5" />
              <Heart className="absolute -bottom-8 -right-8 w-40 h-40 text-white/[0.02] rotate-12" />

              <h2 className="text-sm font-medium text-blue-400/80 mb-2 flex items-center gap-2 relative z-10 uppercase">
                <span className="w-2 h-2 rounded-full bg-blue-500" /> رسالة اليوم
              </h2>
              <p className="text-[1.7rem] font-light leading-snug relative z-10 text-zinc-100 line-clamp-2">{motd}</p>
            </motion.div>

            {/* التذكيرات بجانب رسالة اليوم: ارتفاع ثابت، مربعات 2×2 (القادم أولًا) و«+N» للباقي، فلا يتمدد الصف */}
            <button
              type="button"
              onClick={() => { if (reminderTiles.length) setShowAllReminders(true); }}
              className="col-span-1 text-right bg-zinc-800/40 border border-white/5 rounded-3xl p-3 shadow-xl backdrop-blur-md flex flex-col h-[8.5rem] overflow-hidden focus:outline-none"
              aria-label="كل تذكيرات اليوم"
            >
              <div className="flex items-center justify-between mb-2 shrink-0">
                <h3 className="text-base font-medium flex items-center gap-2 text-zinc-200">
                  <AlertTriangle className="w-5 h-5 text-yellow-500/80" />
                  التذكيرات
                  <span className="text-xs text-zinc-500 font-normal">({reminderTiles.length})</span>
                </h3>
              </div>
              {reminders.length === 0 ? (
                <p className="text-zinc-500 text-center py-4 text-sm">لا توجد تذكيرات</p>
              ) : (() => {
                const shown = reminderTiles.length > 4 ? reminderTiles.slice(0, 3) : reminderTiles;
                const more = reminderTiles.length - shown.length;
                return (
                  <div className="grid grid-cols-2 grid-rows-2 gap-1.5 flex-1 min-h-0">
                    {shown.map((r) => (
                      <div key={r.id} className={`flex items-center gap-2 min-w-0 px-2.5 rounded-xl border ${r.next ? 'bg-yellow-400/10 border-yellow-400/30' : 'bg-white/[0.03] border-white/5'} ${r.passed ? 'opacity-50' : ''}`}>
                        <span className="text-sm font-semibold text-zinc-100 truncate flex-1 min-w-0">{r.text}</span>
                        <span className="text-xs font-mono text-zinc-400 shrink-0" dir="ltr">{r.time}</span>
                      </div>
                    ))}
                    {more > 0 && (
                      <div className="flex items-center justify-center rounded-xl border border-white/5 bg-white/[0.03] text-sm text-zinc-400">
                        +{more} أخرى
                      </div>
                    )}
                  </div>
                );
              })()}
            </button>
          </div>

          {/* --- Row B: مواقيت الصلاة (⅔) + الأزرار الثلاثة (⅓) --- */}
          <div className="grid grid-cols-3 gap-3 items-stretch">
            {/* مواقيت الصلاة */}
            <div className="col-span-2 grid grid-cols-5 gap-2 bg-zinc-800/40 p-3 rounded-3xl border border-white/5 backdrop-blur-xl shadow-2xl">
              {prayers && (
                <>
                  <PrayerCard name="الفجر" time={prayers.Fajr} isActive={nextPrayer?.name === 'Fajr'} countdown={nextPrayer?.name === 'Fajr' ? countdown : null} imminent={nextPrayer?.name === 'Fajr' && (nextPrayer.time.getTime() - Date.now() < 300000)} />
                  <PrayerCard name="الظهر" time={prayers.Dhuhr} isActive={nextPrayer?.name === 'Dhuhr'} countdown={nextPrayer?.name === 'Dhuhr' ? countdown : null} imminent={nextPrayer?.name === 'Dhuhr' && (nextPrayer.time.getTime() - Date.now() < 300000)} />
                  <PrayerCard name="العصر" time={prayers.Asr} isActive={nextPrayer?.name === 'Asr'} countdown={nextPrayer?.name === 'Asr' ? countdown : null} imminent={nextPrayer?.name === 'Asr' && (nextPrayer.time.getTime() - Date.now() < 300000)} />
                  <PrayerCard name="المغرب" time={prayers.Maghrib} isActive={nextPrayer?.name === 'Maghrib'} countdown={nextPrayer?.name === 'Maghrib' ? countdown : null} imminent={nextPrayer?.name === 'Maghrib' && (nextPrayer.time.getTime() - Date.now() < 300000)} />
                  <PrayerCard name="العشاء" time={prayers.Isha} isActive={nextPrayer?.name === 'Isha'} countdown={nextPrayer?.name === 'Isha' ? countdown : null} imminent={nextPrayer?.name === 'Isha' && (nextPrayer.time.getTime() - Date.now() < 300000)} />
                </>
              )}
            </div>

            {/* الأزرار الثلاثة أفقيًا */}
            <div className="col-span-1 grid grid-cols-3 gap-2 bg-zinc-800/40 p-3 rounded-3xl border border-white/5 backdrop-blur-xl shadow-2xl">
              <button
                onClick={() => setActiveTab('quran')}
                className="flex flex-col items-center justify-center gap-2 bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 rounded-2xl p-2 transition-all group focus:outline-none"
              >
                <div className="bg-emerald-500/10 p-2.5 rounded-2xl border border-emerald-500/20 group-hover:bg-emerald-500/20 transition-colors">
                  <BookOpen className="w-8 h-8 text-emerald-400 drop-shadow-md" />
                </div>
                <span className="font-semibold text-sm text-center leading-tight text-zinc-200">القرآن الكريم</span>
              </button>
              <button
                onClick={() => {
                  refreshDailyImage();
                  setActiveTab('photo_viewer');
                }}
                className="flex flex-col items-center justify-center gap-2 bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 rounded-2xl p-2 transition-all group focus:outline-none"
              >
                <div className="bg-purple-500/10 p-2.5 rounded-2xl border border-purple-500/20 group-hover:bg-purple-500/20 transition-colors">
                  <ImageIcon className="w-8 h-8 text-purple-400 drop-shadow-md" />
                </div>
                <span className="font-semibold text-sm text-center leading-tight text-zinc-200">صورة اليوم</span>
              </button>
              <button
                onClick={() => refreshMealSuggestion(true)}
                className="flex flex-col items-center justify-center gap-2 bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 rounded-2xl p-2 transition-all group focus:outline-none"
              >
                <div className="bg-amber-500/10 p-2.5 rounded-2xl border border-amber-500/20 group-hover:bg-amber-500/20 transition-colors">
                  <Utensils className="w-8 h-8 text-amber-400 drop-shadow-md" />
                </div>
                <span className="font-semibold text-sm text-center leading-tight text-zinc-200">وجبة اليوم</span>
              </button>
            </div>
          </div>

          {/* --- Row C: الوصول السريع (عرض كامل) --- */}
          <div className="flex flex-col gap-2 bg-zinc-800/40 p-3 rounded-3xl border border-white/5 backdrop-blur-xl">
            <h3 className="text-base font-medium flex items-center gap-2 text-zinc-400">
              <ChevronLeft className="w-5 h-5 text-zinc-500" />
              الوصول السريع
            </h3>
            <div className="flex gap-4 overflow-x-auto pb-1 scrollbar-hide snap-x snap-mandatory">
              {quickLinks.map((link) => (
                <button
                  key={link.label}
                  onClick={() => handleLaunch(link)}
                  className="flex-none w-28 aspect-square bg-white/[0.03] rounded-3xl border border-white/5 flex flex-col items-center justify-center gap-2 hover:bg-white/10 transition-all focus:outline-none shadow-sm group snap-center"
                >
                   <div className="w-16 h-16 bg-white/[0.05] rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform shadow-inner border border-white/5">
                      <QuickLinkIcon link={link} />
                   </div>
                   <span className="text-base font-semibold text-zinc-300">{link.label}</span>
                </button>
              ))}
            </div>
          </div>

        </div>
      </main>

      {/* --- Tickers --- */}
      <footer className="fixed bottom-0 left-0 right-0 p-0 flex flex-col pt-12 bg-gradient-to-t from-[#020202] via-[#020202]/90 to-transparent pointer-events-none z-20">
        <div className="pointer-events-auto flex flex-col gap-2">
          <NewsTicker items={news} accent="rose" />
          <NewsTicker items={adhkar} accent="emerald" />
        </div>
      </footer>

      {/* رقم الإصدار المنشور — لتتبّع النسخة على التلفزيون. */}
      <span className="fixed top-1 left-2 z-30 text-[10px] font-mono text-white/25 pointer-events-none select-none">
        v{APP_VERSION}
      </span>

      {/* --- كل تذكيرات اليوم (OK على حاوية التذكيرات) --- */}
      <AnimatePresence>
        {showAllReminders && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/90 backdrop-blur-xl z-50 flex items-center justify-center p-8"
            data-focus-trap="true"
            role="dialog"
            aria-modal="true"
          >
            <div className="w-full max-w-2xl bg-zinc-900 border border-white/10 rounded-3xl p-6 shadow-2xl">
              <h2 className="text-2xl font-bold mb-4 flex items-center gap-2 text-zinc-100">
                <AlertTriangle className="w-6 h-6 text-yellow-500/80" /> تذكيرات اليوم
              </h2>
              <div className="grid grid-cols-2 gap-2 mb-5">
                {reminderTiles.map((r) => (
                  <div key={r.id} className={`flex items-center gap-3 px-4 py-3 rounded-2xl border ${r.next ? 'bg-yellow-400/10 border-yellow-400/30' : 'bg-white/[0.03] border-white/5'} ${r.passed ? 'opacity-50' : ''}`}>
                    <span className="flex-1 min-w-0 text-lg font-semibold text-zinc-100 truncate">{r.text}</span>
                    <span className="text-base font-mono text-zinc-400 shrink-0" dir="ltr">{r.time}</span>
                  </div>
                ))}
              </div>
              <button onClick={() => setShowAllReminders(false)} className="w-full py-3 rounded-2xl bg-white/10 text-lg text-zinc-100 focus:outline-none">
                إغلاق
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* --- WiFi Modal --- */}
      <AnimatePresence>
        {showWifi && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/90 backdrop-blur-xl z-50 flex items-center justify-center p-8"
            data-focus-trap="true"
            role="dialog"
            aria-modal="true"
          >
            <div className="w-full max-w-2xl bg-white/5 border border-white/10 rounded-[3rem] p-12 text-center relative">
              <button 
                onClick={() => setShowWifi(false)}
                className="absolute top-8 left-8 p-3 bg-white/10 rounded-full hover:bg-white/20 transition-all"
              >
                <X className="w-8 h-8" />
              </button>
              <Wifi className="w-20 h-20 mx-auto mb-8 text-blue-500" />
              <h2 className="text-4xl font-bold mb-4">الاتصال بالشبكة</h2>
              <p className="text-blue-100/60 text-xl mb-12">امسح رمز الاستجابة السريعة للانضمام إلى الشبكة المنزلية</p>
              
              <div className="flex flex-col md:flex-row items-center gap-12 justify-center">
                <div className="p-4 bg-white rounded-3xl">
                  {wifiInfo.qrImage ? (
                    <img src={wifiInfo.qrImage} alt="Wi-Fi QR" className="w-48 h-48 object-contain" />
                  ) : (
                    <div className="w-48 h-48 bg-slate-200 flex items-center justify-center text-slate-400 text-lg">
                      QR Code
                    </div>
                  )}
                </div>
                {/* The password is not shown (owner decision, UX-AUDIT A1): the QR code joins the network. */}
                <div className="text-right space-y-4">
                  <div className="space-y-1">
                    <p className="text-blue-400 text-base font-bold">اسم الشبكة</p>
                    <p className="text-3xl font-mono" dir="ltr">{wifiInfo.ssid || '—'}</p>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* --- Quran Page Overlay --- */}
      <AnimatePresence>
        {activeTab === 'quran' && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 120 }}
            className="fixed inset-0 bg-slate-900 z-[60] flex flex-col p-8"
            data-focus-trap="true"
          >
             <div className="flex justify-between items-center mb-8 bg-black/20 p-6 rounded-3xl gap-4 flex-wrap">
                <h2 className="text-3xl font-bold flex items-center gap-3">
                  <BookOpen className="w-10 h-10 text-green-400" />
                  القرآن الكريم
                </h2>
                <div className="flex items-center gap-3">
                  <button
                    onClick={fetchCurrentQuranPage}
                    disabled={quranLoading}
                    className="flex items-center gap-2 px-5 py-4 bg-white/5 rounded-2xl font-medium text-base hover:bg-white/10 disabled:opacity-50 transition-all focus:outline-none"
                  >
                    <RefreshCw className={`w-5 h-5 ${quranLoading ? 'animate-spin' : ''}`} />
                    تحديث
                  </button>
                  <button
                    onClick={() => setActiveTab('dashboard')}
                    className="flex items-center gap-2 px-8 py-4 bg-white/5 rounded-2xl font-bold text-lg hover:bg-white/10 transition-all focus:outline-none"
                    autoFocus
                  >
                    <ChevronRight className="w-6 h-6" />
                    العودة للرئيسية
                  </button>
                </div>
             </div>
             <div className="flex-1 min-h-0 overflow-y-auto bg-white/5 rounded-[2.5rem] p-12 custom-scrollbar" data-scroll-area="true">
                <div className="max-w-4xl mx-auto space-y-10">
                   <h3 className="text-center text-4xl text-green-300/80 font-bold">الصفحة {getQuranPage()}</h3>
                   {quranLoading && !quranPage && (
                     <div className="flex flex-col items-center justify-center gap-4 py-24 text-zinc-300">
                       <Loader2 className="w-12 h-12 animate-spin text-green-400" />
                       <p className="text-2xl">جارٍ تحميل الآيات...</p>
                     </div>
                   )}
                   {quranError && !quranLoading && (
                     <div className="text-center py-16 px-8 bg-red-500/10 border border-red-500/30 rounded-3xl">
                       <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-4" />
                       <p className="text-2xl text-red-200">{quranError}</p>
                     </div>
                   )}
                   {quranPage && quranPage.page === getQuranPage() && (
                     <div className="space-y-8">
                       {groupAyahsBySurah(quranPage.ayahs).map((group) => (
                         <div key={`${group.surah.number}-${group.ayahs[0]?.numberInSurah}`} className="space-y-6">
                           <h4 className="text-center text-3xl font-bold text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-2xl py-3">
                             سورة {group.surah.name}
                           </h4>
                           <div className="font-quran text-5xl leading-[5.5rem] text-justify text-white/95 bg-black/30 p-10 rounded-[2.5rem] border border-white/5 shadow-inner">
                             {group.ayahs.map((ayah) => (
                               <span key={ayah.number} className="inline">
                                 {ayah.text}
                                 <span className="inline-flex items-center justify-center w-12 h-12 mx-2 align-middle text-xl font-sans text-amber-300 bg-amber-500/10 border border-amber-500/40 rounded-full">
                                   {ayah.numberInSurah}
                                 </span>{' '}
                               </span>
                             ))}
                           </div>
                         </div>
                       ))}
                     </div>
                   )}
                </div>
             </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* --- Meal Picker Modal --- */}
      <AnimatePresence>
        {showMeal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/90 backdrop-blur-xl z-50 flex items-center justify-center p-8"
            data-focus-trap="true"
            role="dialog"
            aria-modal="true"
          >
            <div className="w-full max-w-xl bg-slate-900 border border-white/10 rounded-[3rem] p-12 text-center relative shadow-2xl">
              <button 
                onClick={() => setShowMeal(false)}
                className="absolute top-8 left-8 p-3 bg-white/10 rounded-full hover:bg-white/20 transition-all focus:outline-none"
                autoFocus
              >
                <X className="w-8 h-8" />
              </button>
              <Utensils className="w-20 h-20 mx-auto mb-8 text-orange-400" />
              <h2 className="text-3xl font-bold mb-4">اقتراح لوجبة اليوم</h2>
              <div className="p-10 bg-orange-500/10 rounded-[2rem] border border-orange-500/20 mb-8">
                 <p className="text-5xl font-black text-orange-200 leading-normal">{randomMeal}</p>
              </div>
              <button
                onClick={pickAnotherMeal}
                className="w-full py-5 bg-orange-600 hover:bg-orange-500 rounded-2xl font-bold text-2xl transition-all shadow-lg active:scale-95 focus:outline-none"
              >
                اقتراح آخر
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {activeTab === 'photo_viewer' && (
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            className="fixed inset-0 bg-black z-[60] flex flex-col"
            data-focus-trap="true"
          >
             <div className="absolute top-8 left-8 right-8 flex justify-between items-center z-10">
                <button 
                  onClick={() => setActiveTab('dashboard')}
                  className="p-4 bg-black/50 backdrop-blur-md rounded-full text-white"
                  autoFocus
                >
                  <X className="w-8 h-8" />
                </button>
                <div className="bg-black/50 backdrop-blur-md px-6 py-3 rounded-full text-xl font-bold">
                  صورة اليوم
                </div>
             </div>
             <div className="flex-1 flex items-center justify-center overflow-hidden">
                {dailyImage ? (
                  <img
                    src={`/today_images/${dailyImage}`}
                    className="max-w-full max-h-full object-contain"
                    alt="Daily Photo"
                  />
                ) : (
                  <div className="px-8 py-6 rounded-3xl bg-white/5 border border-white/10 text-center">
                    <p className="text-3xl text-zinc-300">لا توجد صورة مرفوعة</p>
                    {/* tell the owner how to add one (UX-AUDIT A7) */}
                    <p className="text-lg text-zinc-400 mt-4">ارفع صورة من الجوال (على نفس الشبكة):</p>
                    {adminLink && <p className="text-2xl font-mono text-blue-300 mt-2" dir="ltr">{adminLink}</p>}
                  </div>
                )}
             </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
