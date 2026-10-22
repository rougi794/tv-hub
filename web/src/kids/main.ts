// Kids interface (ported from kids-tv-streaming-spec/kids_tv/index.html v1.4).
// The owner section (↑ ↑ ↓ ↓ ← → + PIN) is the shared one in ../shared/owner.ts.
import './kids.css';
import { ARROWS, HUB_VERSION, hubApi, iconUrl, isBackKey, launchApp, moveFocusAmong, type HubApp } from '../shared/hub';
import { initOwner } from '../shared/owner';
import { channelKey, initChannels } from './channels';
import { closePlayer, initPlayer, player } from './player';
import { initTimeGate } from './timegate';
import { initTop, loadPhoto } from './top';
import { $, emptyRow, findItem, makeItem, markOverflow, renderKeepingFocus, toast } from './ui';
import { initYouTube, listReturn, loadYouTube, ytKey } from './youtube';

// layout is designed for a 1280x720 CSS viewport; scale on other screens (the TV reports 960x540)
function fitScreen(): void { document.documentElement.style.zoom = String(window.innerWidth / 1280); }

// ---------------- layers + spatial navigation (remote) ----------------
function topLayer(): HTMLElement {
  const open = document.querySelectorAll<HTMLElement>('.overlay.open');
  return open.length ? open[open.length - 1] : document.body;
}

function focusables(layer: HTMLElement): HTMLElement[] {
  return Array.from(layer.querySelectorAll<HTMLElement>('.focusable')).filter((el) =>
    el.offsetParent !== null && (layer !== document.body || !el.closest('.overlay')));
}

function focusFirst(layer: HTMLElement = topLayer()): void {
  if (layer === document.body) {                     // start on the channels, not the top cards
    const firstItem = document.querySelector<HTMLElement>('#chanRow .item');
    if (firstItem) { firstItem.focus(); return; }
  }
  focusables(layer)[0]?.focus();
}

function closeLayer(l: HTMLElement): void {
  l.classList.remove('open');
  if (l.id === 'photoLayer') {                        // free the decoded photo; back to the photo card
    $<HTMLImageElement>('photoBig').removeAttribute('src');
    const card = document.getElementById('photoCard');
    if (card) { card.focus(); return; }
  }
  if (l.id === 'ytListLayer') {                       // back to its circle, found by id (the row may have been rebuilt)
    const back = findItem(listReturn);
    if (back) { back.focus(); return; }
  }
  focusFirst();
}

/** The child must always see a highlighted item: if the focus is lost (removed node, body), select the first one. */
function ensureFocus(): void {
  if (document.hidden || player.kind || document.querySelector('.hub-owner.open')) return;
  const a = document.activeElement;
  const layer = topLayer();
  const ok = a instanceof HTMLElement && a.classList.contains('focusable') && a.offsetParent !== null && layer.contains(a)
    && (layer !== document.body || !a.closest('.overlay'));
  if (!ok) focusFirst(layer);
}

function onBack(): void {
  if (player.kind) { closePlayer(() => focusFirst()); return; }
  const l = topLayer();
  if (l !== document.body) closeLayer(l);
}

function onKey(e: KeyboardEvent): void {
  const k = e.keyCode;
  if (player.kind) {                                  // while playing, Back closes the player
    e.preventDefault();
    if (isBackKey(e)) { onBack(); return; }
    if (player.kind === 'yt') ytKey(k); else channelKey(k);
    return;
  }
  const dir = ARROWS[k];
  if (dir) { moveFocusAmong(focusables(topLayer()), dir); e.preventDefault(); return; }
  if (isBackKey(e)) { e.preventDefault(); onBack(); }
}

// ---------------- installed apps chosen by the owner ----------------
function launch(pkg: string): void {
  launchApp(pkg).then((ok) => { if (!ok) toast('تعذر فتح البرنامج'); });
}

function loadKidApps(): Promise<void> {
  const row = $('appsRow');
  return hubApi<HubApp[]>('/kids').then((apps) => {
    const sig = JSON.stringify(apps.map((a) => [a.pkg, a.label]));
    if (row.dataset.sig === sig) return;               // unchanged: keep the nodes and the focus (UX-AUDIT K1)
    row.dataset.sig = sig;
    if (!apps.length) { emptyRow(row, 'لا توجد برامج بعد'); return; }
    renderKeepingFocus(row, () => row.replaceChildren(...apps.map((a) =>
      makeItem(a.label, { img: iconUrl(a.pkg), contain: true, emoji: '🧩', fid: 'app:' + a.pkg, onclick: () => launch(a.pkg) }))));
  }).catch(() => { if (!row.children.length) emptyRow(row, 'لا توجد برامج بعد'); });
}

// Inside Fully Kiosk ("Enable Back Button" ON) Back becomes history.back() and never reaches keydown.
// Keep guard entries in history (refilled on every key press = user activation) so Back becomes a popstate here.
// TV Hub forwards Back as a key event instead, so this is only needed when the page runs in Fully.
function armFullyBackGuard(): void {
  const GUARD_DEPTH = 10;
  const arm = (): void => {
    let n = (history.state && history.state.kids === 'guard' && history.state.n) || 0;
    while (n < GUARD_DEPTH) { n++; history.pushState({ kids: 'guard', n }, ''); }
  };
  history.replaceState({ kids: 'base', n: 0 }, '');
  document.addEventListener('keydown', arm, true);
  window.addEventListener('popstate', onBack);
}

// ---------------- start ----------------
fitScreen();
window.addEventListener('resize', fitScreen);
$('ver').textContent = 'v' + HUB_VERSION;

initOwner({
  mode: 'kids',
  canOpen: () => !player.kind && topLayer() === document.body,
  buttons: [{
    label: '🔄 تحديث فيديوهات يوتيوب',
    run: (say) => {
      say('جاري تحديث الفيديوهات...');
      loadYouTube(true).then((n) => say(n >= 0 ? 'تم التحديث: ' + n + ' فيديو' : 'تعذر التحديث، تحقق من الإنترنت'));
    },
  }],
});

initTop();
$('photoClose').onclick = () => onBack();            // OK on the close button (or Back) closes the photo
initPlayer();
// viewing times set from the phone: when the time of what is playing ends, the player closes
initTimeGate(() => player.key, () => {
  closePlayer(() => focusFirst());
  toast('⏰ انتهى وقت المشاهدة، نلتقي لاحقًا 👋');
});
initYouTube();
const channelsReady = initChannels();
document.addEventListener('keydown', onKey);
if (!window.tvHub) armFullyBackGuard();

window.addEventListener('hub:apps-changed', () => { loadKidApps(); });
setInterval(() => { loadKidApps(); }, 2 * 60 * 1000);     // picks up changes made from the phone admin
window.addEventListener('hub:home', () => {            // Home pressed while this page is showing
  if (player.kind) closePlayer(() => focusFirst());
  document.querySelectorAll('.overlay.open').forEach((l) => l.classList.remove('open'));
  focusFirst();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (player.kind) closePlayer(() => focusFirst()); }   // FR-T5: release the IPTV connection now
  else { loadKidApps(); loadYouTube(); loadPhoto(); }
});
window.addEventListener('pagehide', () => { if (player.kind) closePlayer(() => {}); });

Promise.all([loadKidApps(), channelsReady]).then(() => setTimeout(() => focusFirst(), 300));
setInterval(() => { ensureFocus(); markOverflow(); }, 700);
