// Owner section, shared by both interfaces: ↑ ↑ ↓ ↓ ← → on the main screen, then the owner PIN.
// Holds the interface switch (home / kids), Play Store, system settings, diagnostics, PIN change,
// phone-admin password reset and the list of installed apps.
// It listens on window in the capture phase and is installed before the interface, so while it is open
// no key reaches the page underneath.
import './owner.css';
import {
  ARROWS, HUB_VERSION, getMode, hubApi, iconUrl, isBackKey, isOkKey, launchApp, moveFocusAmong, pageFor, waitText,
  type HubApp, type HubMode,
} from './hub';

export interface OwnerButton { label: string; run: (toast: (msg: string) => void) => void }

export interface OwnerOptions {
  mode: HubMode;
  /** false while the secret sequence must not be watched (e.g. a video is playing). */
  canOpen?: () => boolean;
  /** Extra buttons for this interface (e.g. "refresh YouTube" in kids). */
  buttons?: OwnerButton[];
}

const SECRET = [38, 38, 40, 40, 37, 39];
const MODE_LABEL: Record<HubMode, string> = { home: '🏠 المنزل', kids: '🧒 الأطفال' };

let opts: OwnerOptions;
let root: HTMLDivElement;
let view: 'closed' | 'pin' | 'panel' = 'closed';
let seq: number[] = [];
let ownerPin = '';
let returnFocus: Element | null = null;
let homeLinksChanged = false;      // home: quick links edited here; the dashboard reloads when the panel closes
let toastTimer = 0;

// PIN entry state
let pinMode: 'check' | 'new' | 'confirm' = 'check';
let pin = '';
let pinFirst = '';
let pinThen: 'panel' | 'change' = 'panel';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, onClick: () => void, cls = 'hub-btn'): HTMLButtonElement {
  const b = el('button', cls + ' hub-f', text);
  b.tabIndex = 0;
  b.onclick = onClick;
  return b;
}

export function initOwner(o: OwnerOptions): void {
  opts = o;
  root = el('div', 'hub-owner');
  root.setAttribute('dir', 'rtl');
  document.body.appendChild(root);
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) close();      // forget the PIN when an app opens or the TV sleeps
    else checkMode();
  });
  // e.g. the start page fell back to the kids interface while the TV app was still starting (AUDIT L8)
  setInterval(() => { if (view === 'closed') checkMode(); }, 60 * 1000);
}

export function ownerIsOpen(): boolean { return view !== 'closed'; }

/** If the interface was switched elsewhere (e.g. from another page load), follow it. */
function checkMode(): void {
  getMode().then((m) => { if (m !== opts.mode) location.replace(pageFor(m)); }).catch(() => {});
}

function toast(msg: string): void {
  let t = root.querySelector<HTMLDivElement>('.hub-toast');
  if (!t) { t = el('div', 'hub-toast'); root.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), 2500);
}

function onKey(e: KeyboardEvent): void {
  if (view !== 'closed') {
    e.preventDefault();
    e.stopImmediatePropagation();
    overlayKey(e);
    return;
  }
  if (opts.canOpen && !opts.canOpen()) { seq = []; return; }
  seq.push(e.keyCode);
  if (seq.length > SECRET.length) seq.shift();
  if (seq.join() === SECRET.join()) {
    seq = [];
    e.preventDefault();
    e.stopImmediatePropagation();
    returnFocus = document.activeElement;
    openPin('panel');
  }
}

function overlayKey(e: KeyboardEvent): void {
  if (isBackKey(e)) { if (view === 'pin' && pinThen === 'change' && ownerPin) showPanel(); else close(); return; }
  const dir = ARROWS[e.keyCode];
  if (dir) { moveFocusAmong(Array.from(root.querySelectorAll<HTMLElement>('.hub-f')), dir); return; }
  if (isOkKey(e)) { (document.activeElement as HTMLElement | null)?.click(); return; }
  if (view === 'pin' && e.key.length === 1 && e.key >= '0' && e.key <= '9') padKey(e.key);   // number keys on remotes that have them
}

function show(content: HTMLElement): void {
  root.replaceChildren(content);
  root.classList.add('open');
  // the kids page zooms the whole document to its 1280px design; the owner section is designed for the real viewport
  const z = parseFloat(document.documentElement.style.zoom || '1') || 1;
  root.style.zoom = String(1 / z);
}

function close(): void {
  if (view === 'closed') return;
  view = 'closed';
  ownerPin = '';
  root.classList.remove('open');
  root.replaceChildren();
  if (homeLinksChanged) { homeLinksChanged = false; location.reload(); return; }
  const f = returnFocus as HTMLElement | null;
  if (f && document.contains(f)) f.focus({ preventScroll: true });
}

// ---------------- PIN ----------------
function openPin(then: 'panel' | 'change'): void {
  pin = ''; pinFirst = ''; pinThen = then;
  hubApi<{ set: boolean; lockedFor: number }>('/pin/status').then((st) => {
    view = 'pin';
    if (then === 'change') { pinMode = 'new'; renderPin('رمز جديد', 'أدخل الرمز الجديد (6 إلى 8 أرقام)'); }
    else if (!st.set) { pinMode = 'new'; renderPin('إنشاء رمز المالك', 'أول مرة: اختر رمزًا من 6 إلى 8 أرقام'); }
    else { pinMode = 'check'; renderPin('رمز المالك', st.lockedFor ? waitText(st.lockedFor) : ''); }
  }).catch(() => { view = 'pin'; show(el('div', 'hub-panel', 'خدمة TV Hub غير متاحة')); });
}

let pinShow: HTMLDivElement, pinMsg: HTMLDivElement;
function renderPin(title: string, msg: string): void {
  const box = el('div', 'hub-pin');
  box.appendChild(el('h3', '', title));
  pinShow = el('div', 'hub-pinshow');
  pinMsg = el('div', 'hub-msg', msg);
  const pad = el('div', 'hub-pad');
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✔']) pad.appendChild(button(k, () => padKey(k), 'hub-key'));
  box.append(pinShow, pinMsg, pad);
  show(box);
  (pad.children[0] as HTMLElement).focus();
}

function setPinMsg(msg?: string): void {
  pinShow.textContent = pin.replace(/./g, '●');
  if (msg !== undefined) pinMsg.textContent = msg;
}

function padKey(k: string): void {
  if (k === '⌫') { pin = pin.slice(0, -1); setPinMsg(); return; }
  if (k !== '✔') { if (pin.length < 8) pin += k; setPinMsg(); return; }
  if (pinMode === 'check') {
    hubApi<{ ok: boolean; lockedFor: number }>('/pin/check?pin=' + encodeURIComponent(pin)).then((r) => {
      if (r.ok) { ownerPin = pin; showPanel(); }
      else { pin = ''; setPinMsg(r.lockedFor ? waitText(r.lockedFor) : 'رمز خاطئ'); }
    }).catch(() => setPinMsg('تعذر التحقق'));
  } else if (pinMode === 'new') {
    if (!/^\d{6,8}$/.test(pin)) { pin = ''; setPinMsg('من 6 إلى 8 أرقام'); return; }   // AUDIT S2
    pinFirst = pin; pin = ''; pinMode = 'confirm'; setPinMsg('أعد إدخال الرمز للتأكيد');
  } else {
    if (pin !== pinFirst) { pin = ''; pinMode = 'new'; setPinMsg('غير متطابق، ابدأ من جديد'); return; }
    const q = '/pin/set?pin=' + encodeURIComponent(pin) + (ownerPin ? '&old=' + encodeURIComponent(ownerPin) : '');
    hubApi<{ ok: boolean }>(q).then((r) => {
      if (!r.ok) { pin = ''; pinMode = 'new'; setPinMsg('تعذر حفظ الرمز'); return; }
      ownerPin = pin; toast('تم حفظ الرمز'); showPanel();
    }).catch(() => setPinMsg('تعذر حفظ الرمز'));
  }
}

// ---------------- panel ----------------
function showPanel(): void {
  view = 'panel';
  const p = el('div', 'hub-panel');
  const head = el('div', 'hub-head');
  const ver = el('span', 'hub-ver', 'TV Hub v' + HUB_VERSION);
  head.append(el('h3', '', 'إعدادات المالك'), ver);
  hubApi<{ app?: string }>('/ping').then((p) => { if (p.app) ver.textContent += ' · app ' + p.app; }).catch(() => {});
  p.appendChild(head);

  // interface switch
  const modes = el('div', 'hub-row');
  modes.appendChild(el('span', 'hub-label', 'الواجهة:'));
  (['home', 'kids'] as HubMode[]).forEach((m) => {
    const b = button(MODE_LABEL[m], () => switchMode(m), 'hub-btn hub-mode' + (m === opts.mode ? ' on' : ''));
    modes.appendChild(b);
  });
  p.appendChild(modes);

  // tools
  const tools = el('div', 'hub-row');
  tools.append(
    button('🛒 متجر Play', () => run('com.android.vending')),
    button('⚙️ إعدادات النظام', () => run('settings')),
    button('🩺 التشخيص', () => { location.href = 'diag.html'; }),
  );
  for (const b of opts.buttons || []) tools.appendChild(button(b.label, () => b.run(toast)));
  tools.append(
    button('🔑 تغيير الرمز', () => openPin('change')),
    button('📱 إعادة تعيين كلمة مرور الجوال', resetPhonePass),
    button('✖ إغلاق', close),
  );
  p.appendChild(tools);

  p.appendChild(el('div', 'hub-msg', opts.mode === 'kids'
    ? 'OK على تطبيق = إظهاره أو إخفاؤه في «البرامج» للطفل. زر ▶ لتشغيله.'
    : 'OK على تطبيق = إظهاره أو إخفاؤه في «الوصول السريع». زر ▶ لتشغيله. (الترتيب والأسماء والروابط من صفحة الجوال)'));
  const apps = el('div', 'hub-apps');
  p.appendChild(apps);
  show(p);
  (modes.querySelector('.on') as HTMLElement | null)?.focus();
  loadApps(apps);
}

function switchMode(m: HubMode): void {
  if (m === opts.mode) { toast('هذه هي الواجهة الحالية'); return; }
  hubApi<{ ok: boolean }>('/mode/set?mode=' + m + '&pin=' + encodeURIComponent(ownerPin)).then((r) => {
    if (!r.ok) { toast('لم يُحفظ (أعد إدخال الرمز)'); return; }
    ownerPin = '';
    location.replace(pageFor(m));
  }).catch(() => toast('تعذر تغيير الواجهة'));
}

function run(pkg: string): void {
  launchApp(pkg, ownerPin).then((ok) => { if (!ok) toast('تعذر فتح التطبيق'); });
}

function resetPhonePass(): void {
  hubApi<{ ok: boolean }>('/adminpass/reset?pin=' + encodeURIComponent(ownerPin))
    .then((r) => toast(r.ok ? 'تم — أنشئ كلمة مرور جديدة من الجوال' : 'تعذر (أعد إدخال الرمز)'))
    .catch(() => toast('تعذر'));
}

function loadApps(box: HTMLElement): void {
  const homeLinks = opts.mode === 'home' ? hubApi<string[]>('/home/links').catch(() => [] as string[]) : Promise.resolve([] as string[]);
  Promise.all([hubApi<HubApp[]>('/apps'), homeLinks]).then(([list, links]) => {
    let kidSet = list.filter((a) => a.kid).map((a) => a.pkg);
    let linkSet = links;
    for (const a of list) {
      const wrap = el('div', 'hub-app');
      const row = el('button', 'hub-f hub-appbtn' + (a.kid ? ' on' : ''));
      row.tabIndex = 0;
      const img = new Image(); img.src = iconUrl(a.pkg); img.alt = '';
      const tag = el('span', 'hub-tag', a.kid ? 'ظاهر للطفل' : 'مخفي');
      row.append(img, el('span', 'hub-name', a.label));
      if (opts.mode === 'kids') {
        row.appendChild(tag);
        row.onclick = () => {
          const next = kidSet.includes(a.pkg) ? kidSet.filter((p) => p !== a.pkg) : kidSet.concat(a.pkg);
          hubApi<{ ok: boolean }>('/kids/set?pin=' + encodeURIComponent(ownerPin) + '&pkgs=' + encodeURIComponent(next.join(',')))
            .then((r) => {
              if (!r.ok) { toast('لم يُحفظ (أعد إدخال الرمز)'); return; }
              kidSet = next;
              const on = kidSet.includes(a.pkg);
              row.classList.toggle('on', on);
              tag.textContent = on ? 'ظاهر للطفل' : 'مخفي';
              window.dispatchEvent(new CustomEvent('hub:apps-changed'));
            }).catch(() => toast('تعذر الحفظ'));
        };
        wrap.append(row, button('▶', () => run(a.pkg), 'hub-btn hub-run'));
      } else {
        const shown = (): boolean => linkSet.includes(a.pkg);
        tag.textContent = shown() ? 'في الوصول السريع' : 'مخفي';
        row.classList.toggle('on', shown());
        row.appendChild(tag);
        row.onclick = () => {
          hubApi<{ ok: boolean }>('/home/toggle?pin=' + encodeURIComponent(ownerPin) + '&pkg=' + encodeURIComponent(a.pkg))
            .then((r) => {
              if (!r.ok) { toast('لم يُحفظ (أعد إدخال الرمز)'); return; }
              linkSet = shown() ? linkSet.filter((p) => p !== a.pkg) : linkSet.concat(a.pkg);
              homeLinksChanged = true;
              row.classList.toggle('on', shown());
              tag.textContent = shown() ? 'في الوصول السريع' : 'مخفي';
            }).catch(() => toast('تعذر الحفظ'));
        };
        wrap.append(row, button('▶', () => run(a.pkg), 'hub-btn hub-run'));
      }
      box.appendChild(wrap);
    }
  }).catch(() => box.appendChild(el('div', 'hub-msg', 'تعذر جلب قائمة التطبيقات')));
}
