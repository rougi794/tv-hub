import React, { useCallback, useEffect, useState } from 'react';
import { Trash2, Upload, LogIn, Utensils, Image as ImageIcon, Plus, Pencil, Check, X, LogOut, RefreshCw, Bell, MessageSquare, LayoutGrid, ChevronUp, ChevronDown, Search, Download } from 'lucide-react';
import { APP_VERSION } from './version';
import { TV_UNREACHABLE } from './adminApi';
import KidsAdmin from './KidsAdmin';
import LockCodeSettings from './LockCodeSettings';
import { waitText } from '../shared/hub';
import {
  fetchJson, authHeaders, postJson, uploadToServer, writeJsonToServer, deleteServerFile, appIcon, imageExtension, buildImageName, simpleServerWriteHint, friendlyServerError,
  prepareImage, postAuthed,
} from './adminApi';

// The TV (TV Hub AdminServer, port 8080) checks the admin password on every write (header X-Admin-Pass).
// Login gives an HttpOnly session cookie (12 h); the password itself is not kept in the browser.
const MEALS_PATH = '/data/meals.json';
const IMAGES_PATH = '/data/images.json';
const REMINDERS_PATH = '/data/reminders.json';
const MOTD_PATH = '/data/motd.json';
const QUICKLINKS_PATH = '/data/quicklinks.json';
const DATA_DIR = '/data';
const IMAGES_DIR = '/today_images';
const USER_ICONS_DIR = '/user_icons';

interface AdminStatus {
  set: boolean;
  pinSet?: boolean;          // only before the first password exists
  mode?: 'home' | 'kids';    // from login / session, not public
  lockedFor: number;
}

type Tab = 'home' | 'kids' | 'images' | 'account';

// Which TV this page belongs to (UX-AUDIT P1). The interface is only told after login (AUDIT-2 N9), so the phone
// remembers it per address and the login screen can already say "تلفاز الأطفال" next time.
const MODE_KEY = 'tvhub_mode_' + location.host;
const knownMode = (): 'home' | 'kids' | undefined => {
  try { const m = localStorage.getItem(MODE_KEY); return m === 'kids' || m === 'home' ? m : undefined; } catch { return undefined; }
};
const rememberMode = (m: 'home' | 'kids') => {
  try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
  document.title = deviceTitle(m);
};
const deviceTitle = (m: 'home' | 'kids' | undefined) =>
  (m === 'kids' ? '🧒 تلفاز الأطفال' : m === 'home' ? '🏠 تلفاز المنزل' : '📺 التلفاز') + ' · ' + location.hostname;

const TABS: { id: Tab; label: string }[] = [
  { id: 'home', label: '🏠 المنزل' },
  { id: 'kids', label: '🧒 الأطفال' },
  { id: 'images', label: '🖼️ صور اليوم' },
  { id: 'account', label: '🔑 الحساب' },
];

interface MealsFile {
  meals: string[];
}

interface ImagesFile {
  images: string[];
}

interface Reminder {
  id: string;
  time: string;
  text: string;
  seconds?: number;   // how long the banner stays on the TV (5-120, default 15)
  days?: number[];    // 0 = Sunday ... 6 = Saturday; missing = every day
}

// the banner over any app on the TV (Reminders.java): duration choices and week days
const REMINDER_SECONDS = [10, 15, 30, 60];
const WEEK_DAYS = ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];
const daysLabel = (d?: number[]) => (!d || d.length === 0 || d.length === 7 ? 'كل يوم' : [...d].sort().map((i) => WEEK_DAYS[i]).join('، '));

/** Seven day chips; none selected means every day. */
const DayPicker = ({ value, onChange }: { value: number[]; onChange: (d: number[]) => void }) => (
  <div className="flex flex-wrap gap-1">
    {WEEK_DAYS.map((name, i) => {
      const on = value.includes(i);
      return (
        <button key={i} type="button" onClick={() => onChange(on ? value.filter((x) => x !== i) : [...value, i])}
          className={`px-2.5 py-1.5 rounded-lg text-xs border ${on ? 'bg-yellow-600/30 border-yellow-500/60 text-yellow-200' : 'bg-slate-950 border-white/10 text-slate-400'}`}>
          {name}
        </button>
      );
    })}
  </div>
);

interface RemindersFile {
  reminders: Reminder[];
}

interface MotdFile {
  messages: string[];
}

interface QuickLink {
  type: 'app' | 'url';
  label: string;
  pkg?: string;
  url?: string;
  icon?: string;
  iconUrl?: string;
}

interface InstalledApp {
  pkg: string;
  label: string;
}

export default function Admin() {
  const [session, setSession] = useState(false);
  const [tab, setTab] = useState<Tab>('home');
  const [refreshKey, setRefreshKey] = useState(0);
  const [currentPass, setCurrentPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newPass2, setNewPass2] = useState('');
  const [passMsg, setPassMsg] = useState('');
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [ownerPin, setOwnerPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [meals, setMeals] = useState<string[]>([]);
  const [newMeal, setNewMeal] = useState('');
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');

  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rescanning, setRescanning] = useState(false);

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [newReminderText, setNewReminderText] = useState('');
  const [newReminderTime, setNewReminderTime] = useState('20:00');
  const [newReminderSeconds, setNewReminderSeconds] = useState(15);
  const [newReminderDays, setNewReminderDays] = useState<number[]>([]);
  const [editReminderSeconds, setEditReminderSeconds] = useState(15);
  const [editReminderDays, setEditReminderDays] = useState<number[]>([]);
  const [editingReminderId, setEditingReminderId] = useState<string | null>(null);
  const [editReminderText, setEditReminderText] = useState('');
  const [editReminderTime, setEditReminderTime] = useState('20:00');
  const [savingReminders, setSavingReminders] = useState(false);

  const [messages, setMessages] = useState<string[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [editingMsgIdx, setEditingMsgIdx] = useState<number | null>(null);
  const [editMsgValue, setEditMsgValue] = useState('');
  const [savingMessages, setSavingMessages] = useState(false);

  const [quickLinks, setQuickLinks] = useState<QuickLink[]>([]);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [savingLinks, setSavingLinks] = useState(false);
  const [appSearch, setAppSearch] = useState('');
  const [editingLinkIdx, setEditingLinkIdx] = useState<number | null>(null);
  const [editLinkLabel, setEditLinkLabel] = useState('');
  const [iconUploadingIdx, setIconUploadingIdx] = useState<number | null>(null);
  const [manualType, setManualType] = useState<'app' | 'url'>('app');
  const [manualLabel, setManualLabel] = useState('');
  const [manualTarget, setManualTarget] = useState('');

  const login = useCallback(async (pass: string, silent = false) => {
    try {
      const r = await postJson<{ ok: boolean; lockedFor: number; mode?: 'home' | 'kids' }>('/api/admin/login', { 'X-Admin-Pass': pass });
      if (!r.ok) {
        if (!silent) setError(r.lockedFor ? waitText(r.lockedFor) : 'كلمة المرور غير صحيحة');
        return false;
      }
      if (r.mode) { const mode = r.mode; rememberMode(mode); setStatus((s) => (s ? { ...s, mode } : s)); if (mode === 'kids') setTab('kids'); }
      setSession(true);
      setPassword('');
      setPassword2('');
      setOwnerPin('');
      return true;
    } catch {
      if (!silent) setError(TV_UNREACHABLE);
      return false;
    }
  }, []);

  useEffect(() => {
    fetchJson<AdminStatus | null>('/api/admin/status', null).then((st) => {
      setStatus(st);
      if (!st) { setError(TV_UNREACHABLE); return; }
      if (st.lockedFor) setError(waitText(st.lockedFor));
      // still logged in from earlier (session cookie)?
      // still logged in (session cookie)? the TV then also says which interface it shows (not public, AUDIT-2 N9)
      if (st.set) fetchJson<{ ok: boolean; mode?: 'home' | 'kids' }>('/api/admin/session', { ok: false }).then((r) => {
        if (!r.ok) return;
        if (r.mode) { const mode = r.mode; rememberMode(mode); setStatus((s) => (s ? { ...s, mode } : s)); if (mode === 'kids') setTab('kids'); }
        setSession(true);
      });
    });
    const onExpired = () => { setSession(false); setError('انتهت الجلسة، سجّل الدخول من جديد'); };
    window.addEventListener('admin:expired', onExpired);
    return () => window.removeEventListener('admin:expired', onExpired);
  }, []);

  const fetchData = useCallback(async () => {
    const loadApps = async (): Promise<InstalledApp[]> => {
      try {
        const res = await fetch('/api/apps', { headers: authHeaders(), cache: 'no-store' });
        return res.ok ? ((await res.json()) as InstalledApp[]) : [];
      } catch {
        return [];
      }
    };
    const [mealsData, imagesData, remindersData, motdData, linksData, appsData] = await Promise.all([
      fetchJson<MealsFile>(MEALS_PATH, { meals: [] }),
      fetchJson<ImagesFile>(IMAGES_PATH, { images: [] }),
      fetchJson<RemindersFile>(REMINDERS_PATH, { reminders: [] }),
      fetchJson<MotdFile>(MOTD_PATH, { messages: [] }),
      fetchJson<QuickLink[]>(QUICKLINKS_PATH, []),
      loadApps(),
    ]);
    setMeals(Array.isArray(mealsData.meals) ? mealsData.meals : []);
    setImages(Array.isArray(imagesData.images) ? imagesData.images : []);
    setReminders(Array.isArray(remindersData.reminders) ? remindersData.reminders : []);
    setMessages(Array.isArray(motdData.messages) ? motdData.messages : []);
    setQuickLinks(Array.isArray(linksData) ? linksData : []);
    setInstalledApps(Array.isArray(appsData) ? appsData.slice().sort((a, b) => a.label.localeCompare(b.label)) : []);
  }, []);

  useEffect(() => {
    if (session) fetchData();
  }, [session, fetchData]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (status && !status.set) {
        // first time: the TV keeps the password; it asks for the owner PIN so no one else on the network can claim it
        if (password.length < 8) { setError('8 أحرف على الأقل'); return; }   // the TV refuses shorter ones (AUDIT S2)
        if (password !== password2) { setError('كلمتا المرور غير متطابقتين'); return; }
        const r = await postJson<{ ok: boolean }>('/api/admin/setpass', { 'X-Admin-New': password, 'X-Owner-Pin': ownerPin });
        if (!r.ok) { setError(status.pinSet ? 'تعذر الحفظ — تحقق من رمز المالك' : 'تعذر الحفظ'); return; }
        setStatus({ ...status, set: true });
      }
      await login(password);
    } catch {
      setError(TV_UNREACHABLE);
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPassMsg('');
    if (newPass.length < 8) { setPassMsg('8 أحرف على الأقل'); return; }
    if (newPass !== newPass2) { setPassMsg('كلمتا المرور غير متطابقتين'); return; }
    try {
      // the TV wants the current password typed again, a session alone cannot change it
      const r = await postJson<{ ok: boolean }>('/api/admin/setpass', { 'X-Admin-Pass': currentPass, 'X-Admin-New': newPass });
      if (!r.ok) { setPassMsg('كلمة المرور الحالية غير صحيحة'); return; }
      setCurrentPass('');
      setNewPass('');
      setNewPass2('');
      setPassMsg('تم تغيير كلمة المرور ✅');
    } catch {
      setPassMsg('تعذر الاتصال بالتلفزيون');
    }
  };

  const handleLogout = () => {
    postJson('/api/admin/logout', {}).catch(() => {}).finally(() => setSession(false));
  };

  const saveMeals = async (next: string[]) => {
    const clean = Array.from(new Set(next.map((meal) => meal.trim()).filter(Boolean))).slice(0, 200);
    const previous = meals;
    setMeals(clean);
    setSaving(true);
    try {
      await writeJsonToServer(DATA_DIR, 'meals.json', { meals: clean });
    } catch (e) {
      setMeals(previous);
      alert(friendlyServerError(e, `فشل حفظ الوجبات. ${simpleServerWriteHint}`));
    } finally {
      setSaving(false);
    }
  };

  const saveImages = async (next: string[]) => {
    await writeJsonToServer(DATA_DIR, 'images.json', { images: next });
  };

  const addMeal = (e: React.FormEvent) => {
    e.preventDefault();
    const value = newMeal.trim();
    if (!value) return;
    if (!meals.includes(value)) saveMeals([...meals, value]);
    setNewMeal('');
  };

  const startEdit = (idx: number) => {
    setEditingIdx(idx);
    setEditValue(meals[idx]);
  };

  const cancelEdit = () => {
    setEditingIdx(null);
    setEditValue('');
  };

  const commitEdit = () => {
    if (editingIdx === null) return;
    const value = editValue.trim();
    if (!value) {
      cancelEdit();
      return;
    }
    const next = meals.slice();
    next[editingIdx] = value;
    saveMeals(next);
    cancelEdit();
  };

  const deleteMeal = (idx: number) => {
    if (!confirm(`حذف "${meals[idx]}"؟`)) return;
    saveMeals(meals.filter((_, i) => i !== idx));
  };

  // several photos at once; each is redrawn (no GPS/camera metadata) and large ones scaled down to 1920px
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setUploading(true);
    let current = images;
    try {
      for (const original of files) {
        if (original.size > 25 * 1024 * 1024) { alert(`«${original.name}» أكبر من 25 ميجا`); continue; }
        let file: File;
        try { file = await prepareImage(original); } catch { alert(`«${original.name}»: تعذر قراءة الصورة`); continue; }
        const filename = buildImageName(file);
        if (!filename) { alert(`«${original.name}»: نوع غير مدعوم (JPG / PNG / WEBP فقط)`); continue; }
        await uploadToServer(IMAGES_DIR, new File([file], filename, { type: file.type }), filename);
        current = [...current, filename];
        setImages(current);
        await saveImages(current);
      }
    } catch (err) {
      alert(friendlyServerError(err, `فشل الرفع. ${simpleServerWriteHint}`));
      fetchData();
    } finally {
      setUploading(false);
    }
  };

  const deleteImage = async (filename: string) => {
    if (!confirm('حذف هذه الصورة؟')) return;
    const previous = images;
    const nextImages = images.filter((i) => i !== filename);
    setImages(nextImages);
    try {
      await deleteServerFile(IMAGES_DIR, filename);
      await saveImages(nextImages);
    } catch (e) {
      setImages(previous);
      alert(friendlyServerError(e, `فشل الحذف. ${simpleServerWriteHint}`));
    }
  };

  // إعادة بناء قائمة صور اليوم من الملفات الموجودة فعلياً في today_images/
  // (تُصلح الحالة التي تُستبدل فيها images.json بنسخة فارغة مع بقاء الصور).
  const rescanImages = async () => {
    setRescanning(true);
    try {
      const res = await fetch(`/api/file/list?${new URLSearchParams({ dir: 'today_images' })}`, { headers: authHeaders(), cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // الاستجابة قد تكون مصفوفة مباشرة أو مغلّفة داخل حقل.
      const entries: Array<{ name?: string; directory?: boolean }> = Array.isArray(data)
        ? data
        : (data.files || data.entries || data.data || data.items || []);
      const found = entries
        .filter((e) => e && e.directory !== true && typeof e.name === 'string')
        .map((e) => e.name as string)
        .filter((n) => /\.(jpe?g|png|webp)$/i.test(n));
      const unique = Array.from(new Set(found));
      if (unique.length === 0) {
        alert('لم يُعثر على صور داخل today_images. تأكد أن الصور موجودة داخل مجلد التشغيل.');
        return;
      }
      // ندمج مع القائمة الحالية للحفاظ على أي أسماء صحيحة سابقة.
      const merged = Array.from(new Set([...images.filter((n) => unique.includes(n)), ...unique]));
      setImages(merged);
      await saveImages(merged);
      alert(`تمت المزامنة: ${merged.length} صورة.`);
    } catch (e) {
      alert(friendlyServerError(e, 'تعذّر فحص المجلد على التلفزيون.'));
    } finally {
      setRescanning(false);
    }
  };

  // --- التذكيرات: تُحفظ في data/reminders.json ليقرأها التلفزيون ويعرضها. ---
  const isValidTime = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

  const saveReminders = async (next: Reminder[]) => {
    const sorted = [...next].sort((a, b) => a.time.localeCompare(b.time)).slice(0, 50);
    const previous = reminders;
    setReminders(sorted);
    setSavingReminders(true);
    try {
      await writeJsonToServer(DATA_DIR, 'reminders.json', { reminders: sorted });
    } catch (e) {
      setReminders(previous);
      alert(friendlyServerError(e, `فشل حفظ التذكيرات. ${simpleServerWriteHint}`));
    } finally {
      setSavingReminders(false);
    }
  };

  const addReminder = (e: React.FormEvent) => {
    e.preventDefault();
    const text = newReminderText.trim();
    const time = newReminderTime;
    if (!text || !isValidTime(time)) return;
    const reminder: Reminder = { id: Date.now().toString(), time, text, seconds: newReminderSeconds };
    if (newReminderDays.length > 0 && newReminderDays.length < 7) reminder.days = [...newReminderDays].sort();
    saveReminders([...reminders, reminder]);
    setNewReminderText('');
    setNewReminderTime('20:00');
    setNewReminderDays([]);
  };

  const startEditReminder = (r: Reminder) => {
    setEditingReminderId(r.id);
    setEditReminderText(r.text);
    setEditReminderTime(isValidTime(r.time) ? r.time : '20:00');
    setEditReminderSeconds(r.seconds || 15);
    setEditReminderDays(r.days || []);
  };

  const cancelEditReminder = () => {
    setEditingReminderId(null);
    setEditReminderText('');
  };

  const commitEditReminder = () => {
    if (editingReminderId === null) return;
    const text = editReminderText.trim();
    if (!text || !isValidTime(editReminderTime)) {
      cancelEditReminder();
      return;
    }
    const next = reminders.map((r) =>
      r.id === editingReminderId
        ? { ...r, text, time: editReminderTime, seconds: editReminderSeconds,
            days: editReminderDays.length > 0 && editReminderDays.length < 7 ? [...editReminderDays].sort() : undefined }
        : r,
    );
    saveReminders(next);
    cancelEditReminder();
  };

  const deleteReminder = (id: string) => {
    const target = reminders.find((r) => r.id === id);
    if (!confirm(`حذف التذكير "${target?.text ?? ''}"؟`)) return;
    saveReminders(reminders.filter((r) => r.id !== id));
  };

  // --- الرسائل اليومية: تُحفظ في data/motd.json ويختار التلفزيون رسالة كل يوم. ---
  const saveMessages = async (next: string[]) => {
    const clean = Array.from(new Set(next.map((m) => m.trim()).filter(Boolean))).slice(0, 200);
    const previous = messages;
    setMessages(clean);
    setSavingMessages(true);
    try {
      await writeJsonToServer(DATA_DIR, 'motd.json', { messages: clean });
    } catch (e) {
      setMessages(previous);
      alert(friendlyServerError(e, `فشل حفظ الرسائل. ${simpleServerWriteHint}`));
    } finally {
      setSavingMessages(false);
    }
  };

  const addMessage = (e: React.FormEvent) => {
    e.preventDefault();
    const value = newMessage.trim();
    if (!value) return;
    if (!messages.includes(value)) saveMessages([...messages, value]);
    setNewMessage('');
  };

  const startEditMsg = (idx: number) => {
    setEditingMsgIdx(idx);
    setEditMsgValue(messages[idx]);
  };

  const cancelEditMsg = () => {
    setEditingMsgIdx(null);
    setEditMsgValue('');
  };

  const commitEditMsg = () => {
    if (editingMsgIdx === null) return;
    const value = editMsgValue.trim();
    if (!value) {
      cancelEditMsg();
      return;
    }
    const next = messages.slice();
    next[editingMsgIdx] = value;
    saveMessages(next);
    cancelEditMsg();
  };

  const deleteMessage = (idx: number) => {
    if (!confirm('حذف هذه الرسالة؟')) return;
    saveMessages(messages.filter((_, i) => i !== idx));
  };

  // --- الروابط السريعة: تُحفظ في data/quicklinks.json ويعرضها التلفزيون. ---
  const saveQuickLinks = async (next: QuickLink[]) => {
    const previous = quickLinks;
    setQuickLinks(next);
    setSavingLinks(true);
    try {
      await writeJsonToServer(DATA_DIR, 'quicklinks.json', next);
    } catch (e) {
      setQuickLinks(previous);
      alert(friendlyServerError(e, `فشل حفظ الروابط. ${simpleServerWriteHint}`));
    } finally {
      setSavingLinks(false);
    }
  };

  const addLinkFromApp = (app: InstalledApp) => {
    if (quickLinks.some((l) => l.type === 'app' && l.pkg === app.pkg)) return;
    // the TV draws the app's own banner/icon (TV Hub /api/hub/icon), so no icon upload is needed
    saveQuickLinks([...quickLinks, { type: 'app', label: app.label, pkg: app.pkg, icon: appIcon(app.pkg) }]);
  };

  const addManualLink = (e: React.FormEvent) => {
    e.preventDefault();
    const label = manualLabel.trim();
    const target = manualTarget.trim();
    if (!label || !target) return;
    const link: QuickLink =
      manualType === 'app'
        ? { type: 'app', label, pkg: target, icon: 'default' }
        : { type: 'url', label, url: target, icon: 'default' };
    saveQuickLinks([...quickLinks, link]);
    setManualLabel('');
    setManualTarget('');
  };

  const startEditLink = (idx: number) => {
    setEditingLinkIdx(idx);
    setEditLinkLabel(quickLinks[idx].label);
  };

  const cancelEditLink = () => {
    setEditingLinkIdx(null);
    setEditLinkLabel('');
  };

  const commitEditLink = () => {
    if (editingLinkIdx === null) return;
    const label = editLinkLabel.trim();
    if (!label) {
      cancelEditLink();
      return;
    }
    const next = quickLinks.map((l, i) => (i === editingLinkIdx ? { ...l, label } : l));
    saveQuickLinks(next);
    cancelEditLink();
  };

  const moveLink = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= quickLinks.length) return;
    const next = quickLinks.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    saveQuickLinks(next);
  };

  const deleteLink = (idx: number) => {
    if (!confirm(`حذف "${quickLinks[idx].label}"؟`)) return;
    saveQuickLinks(quickLinks.filter((_, i) => i !== idx));
  };

  const uploadLinkIcon = async (idx: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (file.size > 5 * 1024 * 1024) {
      alert('حجم الأيقونة أكبر من 5 ميجا');
      return;
    }
    if (!imageExtension(file)) {
      alert('نوع الأيقونة غير مدعوم (JPG / PNG / WEBP فقط)');
      return;
    }
    let clean: File;
    try { clean = await prepareImage(file, 512); } catch { alert('تعذر قراءة الأيقونة'); return; }   // drops metadata
    const ext = imageExtension(clean);
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const filename = `icon_${stamp}_${Math.random().toString(16).slice(2, 8)}.${ext}`;
    const renamed = new File([clean], filename, { type: clean.type });
    setIconUploadingIdx(idx);
    try {
      await uploadToServer(USER_ICONS_DIR, renamed, filename);
      const next = quickLinks.map((l, i) => (i === idx ? { ...l, iconUrl: `/user_icons/${filename}` } : l));
      await saveQuickLinks(next);
    } catch (err) {
      alert(friendlyServerError(err, `فشل رفع الأيقونة. ${simpleServerWriteHint}`));
    } finally {
      setIconUploadingIdx(null);
    }
  };

  const clearLinkIcon = (idx: number) => {
    const next = quickLinks.map((l, i) => {
      if (i !== idx) return l;
      const { iconUrl: _drop, ...rest } = l;
      void _drop;
      return { ...rest, icon: 'default' };
    });
    saveQuickLinks(next);
  };

  const linkImgSrc = (l: QuickLink) => {
    if (l.iconUrl) return l.iconUrl;
    if (l.icon && (l.icon.startsWith('/') || l.icon.startsWith('http'))) return l.icon;
    return '';
  };

  const availableApps = installedApps.filter((a) => {
    if (quickLinks.some((l) => l.type === 'app' && l.pkg === a.pkg)) return false;
    const q = appSearch.trim().toLowerCase();
    if (!q) return true;
    return a.label.toLowerCase().includes(q) || a.pkg.toLowerCase().includes(q);
  });

  if (!session) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center font-sans text-white p-4" dir="rtl">
        <form onSubmit={handleLogin} className="bg-slate-900 p-8 rounded-2xl border border-white/10 shadow-2xl w-full max-w-md">
          <div className="flex justify-center mb-6">
            <div className="bg-blue-500/20 p-4 rounded-full">
              <LogIn className="w-10 h-10 text-blue-400" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-center mb-2">{status && !status.set ? 'إنشاء كلمة مرور الإدارة' : 'لوحة التحكم'}</h1>
          <p className="text-center text-sm text-slate-300 mb-1">{deviceTitle(knownMode())}</p>
          {status && !status.set && (
            <p className="text-sm text-slate-400 text-center mb-6 leading-6">
              أول مرة: اختر كلمة مرور (8 أحرف على الأقل). تُحفظ على التلفزيون ويُطلب إدخالها لاحقًا.
              {status.pinSet && ' للتأكيد أدخل رمز المالك الذي تستخدمه في القسم المخفي على التلفزيون.'}
            </p>
          )}
          {(!status || status.set) && <div className="mb-6" />}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="كلمة مرور الإدارة"
            autoFocus
            autoComplete={status && !status.set ? 'new-password' : 'current-password'}
            className="w-full bg-slate-950 border border-white/10 rounded-xl px-4 py-4 mb-4 focus:outline-none focus:border-blue-500 text-center text-lg"
            dir="ltr"
          />
          {status && !status.set && (
            <input
              type="password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              placeholder="أعد كتابة كلمة المرور"
              autoComplete="new-password"
              className="w-full bg-slate-950 border border-white/10 rounded-xl px-4 py-4 mb-4 focus:outline-none focus:border-blue-500 text-center text-lg"
              dir="ltr"
            />
          )}
          {status && !status.set && status.pinSet && (
            <input
              type="password"
              value={ownerPin}
              onChange={(e) => setOwnerPin(e.target.value)}
              placeholder="رمز المالك على التلفزيون"
              inputMode="numeric"
              autoComplete="off"
              className="w-full bg-slate-950 border border-white/10 rounded-xl px-4 py-4 mb-4 focus:outline-none focus:border-blue-500 text-center text-lg"
              dir="ltr"
            />
          )}
          {error && <p className="text-red-400 text-sm mb-4 text-center">{error}</p>}
          <button
            type="submit"
            disabled={busy || !password || !status}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-bold py-4 rounded-xl transition-colors"
          >
            {busy ? '...جاري الدخول' : status && !status.set ? 'حفظ ودخول' : 'دخول'}
          </button>
          <p className="text-xs text-slate-500 mt-5 leading-6 text-center">
            الحفظ يتم على التلفزيون نفسه، ويتحقق التلفزيون من كلمة المرور. إن نسيتها: القسم المخفي على التلفزيون ← «إعادة تعيين كلمة مرور الجوال».
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white font-sans p-3 sm:p-4 md:p-6" dir="rtl">
      <div className="max-w-5xl mx-auto space-y-4 sm:space-y-6">
        <header className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 bg-slate-900/50 p-4 sm:p-5 rounded-2xl border border-white/10">
          <div className="min-w-0">
            <h1 className={`text-xl sm:text-2xl font-bold ${status?.mode === 'kids' ? 'text-amber-300' : 'text-sky-300'}`}>
              {deviceTitle(status?.mode)}
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              الواجهة على التلفزيون الآن: {status?.mode === 'kids' ? '🧒 الأطفال' : '🏠 المنزل'}
              <span className="text-slate-600"> · تُغيَّر من القسم المخفي على التلفزيون</span>
            </p>
          </div>
          <div className="flex gap-2 self-end sm:self-auto">
            <button
              onClick={() => { fetchData(); setRefreshKey((k) => k + 1); }}
              className="flex items-center gap-2 text-slate-300 hover:text-white font-medium px-3 py-2 rounded-lg hover:bg-white/10 transition"
            >
              <RefreshCw className="w-5 h-5" />
              <span className="hidden sm:inline">تحديث</span>
            </button>
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 text-red-400 hover:text-red-300 font-medium px-3 py-2 rounded-lg hover:bg-red-500/10 transition"
            >
              <LogOut className="w-5 h-5" />
              <span className="hidden sm:inline">خروج</span>
            </button>
          </div>
        </header>

        <nav className="grid grid-cols-4 gap-1 bg-slate-900/50 p-1 rounded-2xl border border-white/10 sticky top-2 z-10 backdrop-blur">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-colors ${tab === t.id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-white/5'}`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab === 'home' && (<>
        <LockCodeSettings />
          <section className="bg-slate-900/50 p-4 sm:p-6 rounded-2xl border border-white/10 shadow-xl">
            <h2 className="text-lg sm:text-xl font-bold mb-4 sm:mb-6 flex items-center gap-2 text-orange-400">
              <Utensils className="w-5 h-5 sm:w-6 sm:h-6" />
              إدارة الوجبات
              <span className="text-sm text-slate-500 font-normal mr-auto">{saving ? '...حفظ' : meals.length}</span>
            </h2>

            <form onSubmit={addMeal} className="flex gap-2 mb-6">
              <input
                type="text"
                value={newMeal}
                onChange={(e) => setNewMeal(e.target.value)}
                placeholder="اسم وجبة جديدة..."
                maxLength={80}
                className="flex-1 bg-slate-950 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-orange-500/50"
              />
              <button type="submit" disabled={!newMeal.trim()} className="bg-orange-600 hover:bg-orange-500 disabled:bg-slate-700 text-white p-3 rounded-xl transition-colors">
                <Plus className="w-6 h-6" />
              </button>
            </form>

            <div className="space-y-2 max-h-[28rem] overflow-y-auto pr-1">
              {meals.map((meal, idx) => (
                <div key={`${idx}-${meal}`} className="flex items-center gap-2 bg-slate-950 p-3 rounded-xl border border-white/5">
                  {editingIdx === idx ? (
                    <>
                      <input
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit();
                          if (e.key === 'Escape') cancelEdit();
                        }}
                        autoFocus
                        maxLength={80}
                        className="flex-1 bg-slate-900 border border-orange-500/50 rounded-lg px-3 py-2 focus:outline-none"
                      />
                      <button onClick={commitEdit} className="text-green-400 hover:text-green-300 p-2" aria-label="حفظ">
                        <Check className="w-5 h-5" />
                      </button>
                      <button onClick={cancelEdit} className="text-slate-400 hover:text-slate-200 p-2" aria-label="إلغاء">
                        <X className="w-5 h-5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 font-medium text-lg truncate">{meal}</span>
                      <button onClick={() => startEdit(idx)} className="text-blue-400/70 hover:text-blue-400 p-2 transition-colors" aria-label="تعديل">
                        <Pencil className="w-5 h-5" />
                      </button>
                      <button onClick={() => deleteMeal(idx)} className="text-red-400/60 hover:text-red-400 p-2 transition-colors" aria-label="حذف">
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </>
                  )}
                </div>
              ))}
              {meals.length === 0 && <p className="text-slate-500 text-center py-6">لا توجد وجبات بعد</p>}
            </div>
          </section>

        {/* --- إدارة التذكيرات (تظهر على شاشة التلفزيون) --- */}
        <section className="bg-slate-900/50 p-4 sm:p-6 rounded-2xl border border-white/10 shadow-xl">
          <h2 className="text-lg sm:text-xl font-bold mb-4 sm:mb-6 flex items-center gap-2 text-yellow-400">
            <Bell className="w-5 h-5 sm:w-6 sm:h-6" />
            التذكيرات
            <span className="text-sm text-slate-500 font-normal mr-auto">{savingReminders ? '...حفظ' : reminders.length}</span>
          </h2>

          <p className="text-xs text-slate-400 mb-3 leading-6">
            يظهر التذكير في أعلى شاشة التلفزيون فوق أي تطبيق (يوتيوب، مسلسل...) مع صوت قصير، للمدة المختارة.
            يظهر فقط إذا كان التلفزيون يعمل وقت التذكير؛ التذكير الفائت والتلفزيون مطفأ لا يظهر لاحقًا.
          </p>
          <form onSubmit={addReminder} className="flex flex-col gap-2 mb-6">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={newReminderText}
              onChange={(e) => setNewReminderText(e.target.value)}
              placeholder="نص التذكير... (مثال: موعد الدواء)"
              maxLength={80}
              className="flex-1 bg-slate-950 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-yellow-500/50"
            />
            <input
              type="time"
              value={newReminderTime}
              onChange={(e) => setNewReminderTime(e.target.value)}
              className="bg-slate-950 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-yellow-500/50"
              dir="ltr"
            />
            <button
              type="submit"
              disabled={!newReminderText.trim() || !isValidTime(newReminderTime)}
              className="bg-yellow-600 hover:bg-yellow-500 disabled:bg-slate-700 text-white p-3 rounded-xl transition-colors flex items-center justify-center"
              aria-label="إضافة تذكير"
            >
              <Plus className="w-6 h-6" />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-400">مدة التنبيه:</span>
            <select value={newReminderSeconds} onChange={(e) => setNewReminderSeconds(Number(e.target.value))}
              className="bg-slate-950 border border-white/10 rounded-lg px-3 py-1.5">
              {REMINDER_SECONDS.map((v) => <option key={v} value={v}>{v} ثانية</option>)}
            </select>
            <span className="text-slate-400 mr-2">الأيام:</span>
            <DayPicker value={newReminderDays} onChange={setNewReminderDays} />
            <span className="text-xs text-slate-500">{daysLabel(newReminderDays)}</span>
          </div>
          </form>

          <div className="space-y-2 max-h-[24rem] overflow-y-auto pr-1">
            {reminders.map((r) => (
              <div key={r.id} className="bg-slate-950 p-3 rounded-xl border border-white/5 space-y-2">
              <div className="flex items-center gap-2">
                {editingReminderId === r.id ? (
                  <>
                    <input
                      type="text"
                      value={editReminderText}
                      onChange={(e) => setEditReminderText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitEditReminder();
                        if (e.key === 'Escape') cancelEditReminder();
                      }}
                      autoFocus
                      maxLength={80}
                      className="flex-1 bg-slate-900 border border-yellow-500/50 rounded-lg px-3 py-2 focus:outline-none"
                    />
                    <input
                      type="time"
                      value={editReminderTime}
                      onChange={(e) => setEditReminderTime(e.target.value)}
                      className="bg-slate-900 border border-yellow-500/50 rounded-lg px-3 py-2 focus:outline-none"
                      dir="ltr"
                    />
                    <select value={editReminderSeconds} onChange={(e) => setEditReminderSeconds(Number(e.target.value))}
                      className="bg-slate-900 border border-yellow-500/50 rounded-lg px-2 py-2 text-sm" aria-label="مدة التنبيه">
                      {REMINDER_SECONDS.map((v) => <option key={v} value={v}>{v} ث</option>)}
                    </select>
                    <button onClick={commitEditReminder} className="text-green-400 hover:text-green-300 p-2" aria-label="حفظ">
                      <Check className="w-5 h-5" />
                    </button>
                    <button onClick={cancelEditReminder} className="text-slate-400 hover:text-slate-200 p-2" aria-label="إلغاء">
                      <X className="w-5 h-5" />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium text-lg truncate">{r.text}</span>
                      <span className="block text-xs text-slate-500">{daysLabel(r.days)} · {r.seconds || 15} ثانية</span>
                    </span>
                    <span className="text-sm text-slate-400 font-mono" dir="ltr">{r.time}</span>
                    <button onClick={() => startEditReminder(r)} className="text-blue-400/70 hover:text-blue-400 p-2 transition-colors" aria-label="تعديل">
                      <Pencil className="w-5 h-5" />
                    </button>
                    <button onClick={() => deleteReminder(r.id)} className="text-red-400/60 hover:text-red-400 p-2 transition-colors" aria-label="حذف">
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </>
                )}
              </div>
              {editingReminderId === r.id && <DayPicker value={editReminderDays} onChange={setEditReminderDays} />}
              </div>
            ))}
            {reminders.length === 0 && <p className="text-slate-500 text-center py-6">لا توجد تذكيرات بعد</p>}
          </div>
        </section>

        {/* --- إدارة الرسائل اليومية (رسالة اليوم على التلفزيون) --- */}
        <section className="bg-slate-900/50 p-4 sm:p-6 rounded-2xl border border-white/10 shadow-xl">
          <h2 className="text-lg sm:text-xl font-bold mb-4 sm:mb-6 flex items-center gap-2 text-sky-400">
            <MessageSquare className="w-5 h-5 sm:w-6 sm:h-6" />
            الرسائل اليومية
            <span className="text-sm text-slate-500 font-normal mr-auto">{savingMessages ? '...حفظ' : messages.length}</span>
          </h2>

          <p className="text-xs text-slate-400 mb-4 leading-6">
            يختار التلفزيون رسالة واحدة من هذه المجموعة كل يوم ويعرضها في «رسالة اليوم».
          </p>

          <form onSubmit={addMessage} className="flex gap-2 mb-6">
            <textarea
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              placeholder="نص رسالة جديدة..."
              maxLength={280}
              rows={2}
              className="flex-1 bg-slate-950 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-sky-500/50 resize-y"
            />
            <button type="submit" disabled={!newMessage.trim()} className="bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 text-white p-3 rounded-xl transition-colors self-start" aria-label="إضافة رسالة">
              <Plus className="w-6 h-6" />
            </button>
          </form>

          <div className="space-y-2 max-h-[28rem] overflow-y-auto pr-1">
            {messages.map((msg, idx) => (
              <div key={`${idx}-${msg.slice(0, 12)}`} className="flex items-start gap-2 bg-slate-950 p-3 rounded-xl border border-white/5">
                {editingMsgIdx === idx ? (
                  <>
                    <textarea
                      value={editMsgValue}
                      onChange={(e) => setEditMsgValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitEditMsg();
                        if (e.key === 'Escape') cancelEditMsg();
                      }}
                      autoFocus
                      maxLength={280}
                      rows={2}
                      className="flex-1 bg-slate-900 border border-sky-500/50 rounded-lg px-3 py-2 focus:outline-none resize-y"
                    />
                    <button onClick={commitEditMsg} className="text-green-400 hover:text-green-300 p-2" aria-label="حفظ">
                      <Check className="w-5 h-5" />
                    </button>
                    <button onClick={cancelEditMsg} className="text-slate-400 hover:text-slate-200 p-2" aria-label="إلغاء">
                      <X className="w-5 h-5" />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 font-medium leading-7">{msg}</span>
                    <button onClick={() => startEditMsg(idx)} className="text-blue-400/70 hover:text-blue-400 p-2 transition-colors shrink-0" aria-label="تعديل">
                      <Pencil className="w-5 h-5" />
                    </button>
                    <button onClick={() => deleteMessage(idx)} className="text-red-400/60 hover:text-red-400 p-2 transition-colors shrink-0" aria-label="حذف">
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </>
                )}
              </div>
            ))}
            {messages.length === 0 && <p className="text-slate-500 text-center py-6">لا توجد رسائل بعد</p>}
          </div>
        </section>

        {/* --- الروابط السريعة (تطبيقات/روابط الشاشة الرئيسية على التلفزيون) --- */}
        <section className="bg-slate-900/50 p-4 sm:p-6 rounded-2xl border border-white/10 shadow-xl">
          <h2 className="text-lg sm:text-xl font-bold mb-4 sm:mb-6 flex items-center gap-2 text-emerald-400">
            <LayoutGrid className="w-5 h-5 sm:w-6 sm:h-6" />
            الروابط السريعة
            <span className="text-sm text-slate-500 font-normal mr-auto">{savingLinks ? '...حفظ' : quickLinks.length}</span>
          </h2>

          {/* القائمة الحالية */}
          <div className="space-y-2 mb-6">
            {quickLinks.map((link, idx) => (
              <div key={`${idx}-${link.label}`} className="flex items-center gap-2 bg-slate-950 p-2 sm:p-3 rounded-xl border border-white/5">
                <div className="flex flex-col">
                  <button onClick={() => moveLink(idx, -1)} disabled={idx === 0} className="text-slate-400 hover:text-white disabled:opacity-20 p-0.5" aria-label="أعلى">
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button onClick={() => moveLink(idx, 1)} disabled={idx === quickLinks.length - 1} className="text-slate-400 hover:text-white disabled:opacity-20 p-0.5" aria-label="أسفل">
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </div>

                <div className="w-11 h-11 shrink-0 bg-slate-900 rounded-lg border border-white/10 flex items-center justify-center overflow-hidden">
                  {linkImgSrc(link) ? (
                    <img src={linkImgSrc(link)} alt="" className="w-9 h-9 object-contain" />
                  ) : (
                    <span className="text-slate-500 text-xs">{link.type === 'url' ? '🔗' : '📦'}</span>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  {editingLinkIdx === idx ? (
                    <input
                      type="text"
                      value={editLinkLabel}
                      onChange={(e) => setEditLinkLabel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitEditLink();
                        if (e.key === 'Escape') cancelEditLink();
                      }}
                      autoFocus
                      maxLength={40}
                      className="w-full bg-slate-900 border border-emerald-500/50 rounded-lg px-3 py-1.5 focus:outline-none"
                    />
                  ) : (
                    <>
                      <div className="font-semibold truncate">{link.label}</div>
                      <div className="text-xs text-slate-500 truncate font-mono" dir="ltr">{link.pkg || link.url}</div>
                    </>
                  )}
                </div>

                {editingLinkIdx === idx ? (
                  <>
                    <button onClick={commitEditLink} className="text-green-400 hover:text-green-300 p-2" aria-label="حفظ"><Check className="w-5 h-5" /></button>
                    <button onClick={cancelEditLink} className="text-slate-400 hover:text-slate-200 p-2" aria-label="إلغاء"><X className="w-5 h-5" /></button>
                  </>
                ) : (
                  <>
                    <label className="text-purple-400/70 hover:text-purple-400 p-2 transition-colors cursor-pointer" title="رفع أيقونة">
                      {iconUploadingIdx === idx ? <RefreshCw className="w-5 h-5 animate-spin" /> : <ImageIcon className="w-5 h-5" />}
                      <input type="file" accept="image/png,image/jpeg,image/jpg,image/webp" className="hidden" onChange={(e) => uploadLinkIcon(idx, e)} disabled={iconUploadingIdx !== null} />
                    </label>
                    {(link.iconUrl || linkImgSrc(link)) && (
                      <button onClick={() => clearLinkIcon(idx)} className="text-slate-500 hover:text-slate-300 p-2" title="إزالة الأيقونة" aria-label="إزالة الأيقونة"><X className="w-4 h-4" /></button>
                    )}
                    <button onClick={() => startEditLink(idx)} className="text-blue-400/70 hover:text-blue-400 p-2 transition-colors" aria-label="تعديل الاسم"><Pencil className="w-5 h-5" /></button>
                    <button onClick={() => deleteLink(idx)} className="text-red-400/60 hover:text-red-400 p-2 transition-colors" aria-label="حذف"><Trash2 className="w-5 h-5" /></button>
                  </>
                )}
              </div>
            ))}
            {quickLinks.length === 0 && <p className="text-slate-500 text-center py-4">لا توجد روابط بعد</p>}
          </div>

          {/* إضافة من التطبيقات المثبّتة */}
          <div className="border-t border-white/10 pt-5">
            <h3 className="text-sm font-bold text-slate-300 mb-3 flex items-center gap-2">
              <Plus className="w-4 h-4" /> إضافة من التطبيقات المثبّتة على التلفزيون
            </h3>
            {installedApps.length > 0 ? (
              <>
                <div className="relative mb-3">
                  <Search className="w-4 h-4 text-slate-500 absolute top-1/2 -translate-y-1/2 right-3" />
                  <input
                    type="text"
                    value={appSearch}
                    onChange={(e) => setAppSearch(e.target.value)}
                    placeholder="ابحث باسم التطبيق أو الحزمة..."
                    className="w-full bg-slate-950 border border-white/10 rounded-xl pr-9 pl-4 py-2.5 focus:outline-none focus:border-emerald-500/50"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-1">
                  {availableApps.map((app) => (
                    <button
                      key={app.pkg}
                      onClick={() => addLinkFromApp(app)}
                      className="flex items-center gap-2 bg-slate-950 hover:bg-emerald-500/10 border border-white/5 rounded-lg px-3 py-2 text-right transition-colors"
                    >
                      <img src={appIcon(app.pkg)} alt="" className="w-12 h-7 object-contain bg-white rounded shrink-0" loading="lazy" />
                      <span className="flex-1 min-w-0">
                        <span className="block truncate font-medium">{app.label}</span>
                        <span className="block truncate text-xs text-slate-500 font-mono" dir="ltr">{app.pkg}</span>
                      </span>
                    </button>
                  ))}
                  {availableApps.length === 0 && <p className="text-slate-500 text-sm col-span-2 py-2">كل التطبيقات مُضافة أو لا نتيجة للبحث.</p>}
                </div>
              </>
            ) : (
              <p className="text-slate-500 text-sm leading-6 bg-slate-950 rounded-xl p-3 border border-white/5">
                تعذر جلب قائمة التطبيقات من التلفزيون. أعد تحميل الصفحة، أو أضِف التطبيق يدويًا بالأسفل باسم الحزمة.
              </p>
            )}
          </div>

          {/* إضافة يدوية */}
          <form onSubmit={addManualLink} className="border-t border-white/10 pt-5 mt-5 space-y-2">
            <h3 className="text-sm font-bold text-slate-300 mb-1">إضافة يدوية</h3>
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                value={manualType}
                onChange={(e) => setManualType(e.target.value as 'app' | 'url')}
                className="bg-slate-950 border border-white/10 rounded-xl px-3 py-3 focus:outline-none focus:border-emerald-500/50"
              >
                <option value="app">تطبيق</option>
                <option value="url">رابط</option>
              </select>
              <input
                type="text"
                value={manualLabel}
                onChange={(e) => setManualLabel(e.target.value)}
                placeholder="الاسم الظاهر"
                maxLength={40}
                className="flex-1 bg-slate-950 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-emerald-500/50"
              />
              <input
                type="text"
                value={manualTarget}
                onChange={(e) => setManualTarget(e.target.value)}
                placeholder={manualType === 'app' ? 'اسم الحزمة (مثال: com.google.android.youtube.tv)' : 'https://...'}
                dir="ltr"
                className="flex-1 bg-slate-950 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-emerald-500/50 text-left"
              />
              <button type="submit" disabled={!manualLabel.trim() || !manualTarget.trim()} className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 text-white p-3 rounded-xl transition-colors" aria-label="إضافة">
                <Plus className="w-6 h-6" />
              </button>
            </div>
          </form>
        </section>
        </>)}

        {tab === 'kids' && <KidsAdmin refreshKey={refreshKey} />}

        {tab === 'images' && (
          <section className="bg-slate-900/50 p-4 sm:p-6 rounded-2xl border border-white/10 shadow-xl">
            <h2 className="text-lg sm:text-xl font-bold mb-4 sm:mb-6 flex items-center gap-2 text-purple-400">
              <ImageIcon className="w-5 h-5 sm:w-6 sm:h-6" />
              صور اليوم
              <button
                onClick={rescanImages}
                disabled={rescanning}
                className="mr-auto flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 disabled:opacity-50 px-3 py-1.5 rounded-lg transition-colors"
                title="إعادة بناء القائمة من الملفات الموجودة في today_images"
              >
                <RefreshCw className={`w-4 h-4 ${rescanning ? 'animate-spin' : ''}`} />
                {rescanning ? '...فحص' : 'إعادة فحص المجلد'}
              </button>
              <a
                href="/api/backup/images.zip"
                download="tv-hub-photos.zip"
                className="flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded-lg transition-colors"
                title="نسخة احتياطية: كل الصور والأيقونات في ملف zip واحد"
              >
                <Download className="w-4 h-4" />
                تنزيل كل الصور
              </a>
              <span className="text-sm text-slate-500 font-normal">{images.length}</span>
            </h2>

            <div className="mb-6">
              <label className="flex items-center justify-center w-full h-32 border-2 border-dashed border-purple-500/30 rounded-2xl hover:bg-purple-500/5 hover:border-purple-500/50 transition-colors cursor-pointer relative overflow-hidden">
                <div className="flex flex-col items-center gap-2 text-purple-400/70">
                  {uploading ? (
                    <span className="animate-pulse">...جاري الرفع</span>
                  ) : (
                    <>
                      <Upload className="w-8 h-8" />
                      <span>اضغط لرفع صورة (JPG / PNG / WEBP)</span>
                    </>
                  )}
                </div>
                <input
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/jpg,image/webp"
                  className="hidden"
                  onChange={handleFileUpload}
                  disabled={uploading}
                />
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[28rem] overflow-y-auto pr-1">
              {images.map((img) => (
                <div key={img} className="relative group bg-slate-950 rounded-xl overflow-hidden aspect-video border border-white/10">
                  <img src={`/today_images/${img}`} alt={img} className="w-full h-full object-cover" loading="lazy" />
                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex items-center justify-center">
                    <button onClick={() => deleteImage(img)} className="bg-red-500 p-2 rounded-full hover:bg-red-600 transition-colors" aria-label="حذف الصورة">
                      <Trash2 className="w-5 h-5 text-white" />
                    </button>
                  </div>
                </div>
              ))}
              {images.length === 0 && <p className="col-span-2 text-slate-500 text-center py-6">لا توجد صور مرفوعة</p>}
            </div>
          </section>
        )}

        {tab === 'account' && (
          <section className="bg-slate-900/50 p-4 sm:p-6 rounded-2xl border border-white/10 shadow-xl">
            <h2 className="text-lg sm:text-xl font-bold mb-4">🔑 تغيير كلمة مرور الإدارة</h2>
            <form onSubmit={changePassword} className="space-y-2 max-w-md">
              <input type="password" value={currentPass} onChange={(e) => setCurrentPass(e.target.value)} placeholder="كلمة المرور الحالية" autoComplete="current-password" dir="ltr"
                className="w-full bg-slate-950 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-blue-500" />
              <input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} placeholder="كلمة المرور الجديدة (8 أحرف على الأقل)" autoComplete="new-password" dir="ltr"
                className="w-full bg-slate-950 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-blue-500" />
              <input type="password" value={newPass2} onChange={(e) => setNewPass2(e.target.value)} placeholder="أعد كتابتها" autoComplete="new-password" dir="ltr"
                className="w-full bg-slate-950 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-blue-500" />
              <button type="submit" disabled={!newPass || !currentPass} className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white font-bold px-6 py-3 rounded-xl">حفظ</button>
              {passMsg && <p className="text-sm text-slate-300">{passMsg}</p>}
            </form>
            <p className="text-xs text-slate-500 mt-4 leading-6">
              إن نُسيت كلمة المرور: القسم المخفي على التلفزيون (↑ ↑ ↓ ↓ ← → ثم رمز المالك) ← «إعادة تعيين كلمة مرور الجوال»، ثم أنشئ كلمة جديدة من هنا.
            </p>
          </section>
        )}

        <p className="text-center text-xs text-slate-600 font-mono pt-2">لوحة الإدارة · v{APP_VERSION}</p>
      </div>
    </div>
  );
}
