// Top row: clock + dates, letter of the day, picture of the day.
import { getJson } from '../shared/hub';
import { $, dateKey, dateSeed, dayIndex, toast } from './ui';

const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function pad2(n: number): string { return (n < 10 ? '0' : '') + n; }

function hijri(d: Date): string {
  try {
    return new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: '2-digit', month: '2-digit', year: 'numeric' })
      .format(d).replace(/[^\d/]/g, '');
  } catch { return ''; }
}

function tick(): void {
  const d = new Date(), h = d.getHours(), h12 = h % 12 || 12;
  $('time').textContent = pad2(h12) + ':' + pad2(d.getMinutes()) + (h < 12 ? ' ص' : ' م');
  $('greet').textContent = (h < 12 ? 'صباح الخير ☀️' : h < 18 ? 'مساء الخير 🌤️' : 'مساء الخير 🌙') + ' — ' + DAYS[d.getDay()];
  const dates = $('dates');
  dates.replaceChildren(
    document.createTextNode(pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() + ' م'),
    document.createElement('br'),
    document.createTextNode(hijri(d) + ' هـ'),
  );
}

const LETTERS: [string, string, string][] = [
  ['أ', 'أرنب', '🐰'], ['ب', 'بطة', '🦆'], ['ت', 'تفاحة', '🍎'], ['ث', 'ثعلب', '🦊'], ['ج', 'جمل', '🐫'],
  ['ح', 'حصان', '🐴'], ['خ', 'خروف', '🐑'], ['د', 'دب', '🐻'], ['ذ', 'ذرة', '🌽'], ['ر', 'رائد فضاء', '🧑‍🚀'],
  ['ز', 'زرافة', '🦒'], ['س', 'سمكة', '🐟'], ['ش', 'شمس', '☀️'], ['ص', 'صاروخ', '🚀'], ['ض', 'ضفدع', '🐸'],
  ['ط', 'طائرة', '✈️'], ['ظ', 'ظرف', '✉️'], ['ع', 'عنب', '🍇'], ['غ', 'غيمة', '☁️'], ['ف', 'فيل', '🐘'],
  ['ق', 'قطة', '🐱'], ['ك', 'كتاب', '📖'], ['ل', 'ليمون', '🍋'], ['م', 'موز', '🍌'], ['ن', 'نحلة', '🐝'],
  ['هـ', 'هدية', '🎁'], ['و', 'وردة', '🌹'], ['ي', 'يد', '✋'],
];

function letterOfDay(): void {
  const [letter, word, pic] = LETTERS[dayIndex() % LETTERS.length];
  $('letterBig').textContent = letter;
  $('letterPic').textContent = pic;
  const b = document.createElement('b');
  b.textContent = word.charAt(0);
  $('letterWord').replaceChildren(b, document.createTextNode(word.slice(1)));
}

// ---------------- picture of the day ----------------
// Uploaded from the owner's phone into today_images/ + data/images.json { "images": [names] }.
// One image per day (stable hash of the local date, remembered so it does not jump if the list changes
// during the day), same pick as the phone admin page. Emoji fallback when empty.
const PHOTO_EMOJI = ['🦁', '🐯', '🦖', '🚀', '🏎️', '⚽', '🛸', '🦅', '🐬', '🚂', '🦈', '🏰'];
const PHOTO_KEY = 'kids_photo';
let photoShown = '';

function pickDaily(items: string[]): string {
  const key = dateKey();
  try {
    const st = JSON.parse(localStorage.getItem(PHOTO_KEY) || '{}') as { date?: string; value?: string };
    if (st.date === key && st.value && items.includes(st.value)) return st.value;
  } catch { /* broken storage: fall through to the deterministic pick */ }
  const v = items[dateSeed(PHOTO_KEY + '-' + key) % items.length];
  try { localStorage.setItem(PHOTO_KEY, JSON.stringify({ date: key, value: v })); } catch { /* ignore */ }
  return v;
}

function showPhotoEmoji(): void {
  photoShown = '';
  $('photo').hidden = true;
  const e = $('photoEmoji');
  e.hidden = false;
  e.textContent = PHOTO_EMOJI[dayIndex() % PHOTO_EMOJI.length];
}

export function loadPhoto(): void {
  getJson<{ images?: string[] }>('data/images.json').then((j) => {
    const imgs = j.images || [];
    if (!imgs.length) throw new Error('no images');
    const name = pickDaily(imgs);
    if (name === photoShown) return;
    photoShown = name;
    const p = $<HTMLImageElement>('photo');
    p.onerror = showPhotoEmoji;
    p.src = 'today_images/' + encodeURIComponent(name);
    p.hidden = false;
    $('photoEmoji').hidden = true;
  }).catch(showPhotoEmoji);
}

export function initTop(): void {
  tick();
  setInterval(tick, 1000);
  letterOfDay();
  $('photoCard').onclick = () => {
    const p = $<HTMLImageElement>('photo');
    if (p.hidden) { toast('لا توجد صورة اليوم بعد'); return; }
    $<HTMLImageElement>('photoBig').src = p.src;
    $('photoLayer').classList.add('open');
    $('photoClose').focus();                         // OK closes it again
  };
  loadPhoto();
  setInterval(loadPhoto, 10 * 60 * 1000);    // picks up new uploads and the midnight change
}
