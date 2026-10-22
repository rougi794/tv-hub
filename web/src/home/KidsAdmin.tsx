// Phone admin, "kids" tab: TV channels, YouTube playlists (with viewing times) and the apps shown to the child.
import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Clock, ImagePlus, Pencil, Plus, RefreshCw, Trash2, Tv, Youtube, Puzzle, X } from 'lucide-react';
import { appIcon, fetchAuthed, fetchJson, friendlyServerError, imageExtension, postAuthed, prepareImage, uploadToServer, writeJsonToServer } from './adminApi';
import type { Schedule, ScheduleFile, TimeWindow } from '../shared/schedule';
import ScheduleEditor, { ScheduleSummary } from './ScheduleEditor';
import StreamSettings from './StreamSettings';

interface Channel { id: string; name: string; icon?: string; [key: string]: unknown }
interface ChannelsFile { version?: number; channels: Channel[]; [key: string]: unknown }
interface Playlist { id: string; name: string }
interface App { pkg: string; label: string }

const card = 'bg-slate-900/50 p-4 sm:p-6 rounded-2xl border border-white/10 shadow-xl';
const row = 'flex items-center gap-2 bg-slate-950 p-3 rounded-xl border border-white/5';
const input = 'bg-slate-950 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-sky-500/50';
const iconBtn = 'p-2 transition-colors disabled:opacity-30';

function move<T>(list: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const next = list.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Playlist id from a YouTube link (…list=PL…) or a bare id. */
function playlistIdFrom(text: string): string {
  const t = text.trim();
  const m = t.match(/[?&]list=([A-Za-z0-9_-]{10,64})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,64}$/.test(t) ? t : '';
}

export default function KidsAdmin({ refreshKey }: { refreshKey: number }) {
  // ---------------- channels ----------------
  const [chFile, setChFile] = useState<ChannelsFile>({ channels: [] });
  const [chEdit, setChEdit] = useState<number | null>(null);
  const [chEditName, setChEditName] = useState('');
  const [newChId, setNewChId] = useState('');
  const [newChName, setNewChName] = useState('');

  // ---------------- playlists ----------------
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [plUrl, setPlUrl] = useState('');
  const [plName, setPlName] = useState('');
  const [plMsg, setPlMsg] = useState('');

  // ---------------- child's apps ----------------
  const [apps, setApps] = useState<App[]>([]);
  const [kids, setKids] = useState<string[]>([]);

  // ---------------- viewing times (data/schedule.json) ----------------
  const [schedule, setSchedule] = useState<Schedule>({});
  const [timeKey, setTimeKey] = useState<string | null>(null);   // item whose time editor is open

  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [ch, pl, all, kidList, sched] = await Promise.all([
      fetchJson<ChannelsFile>('/data/channels.json', { channels: [] }),
      fetchJson<{ playlists?: Playlist[] }>('/data/playlists.json', { playlists: [] }),
      fetchAuthed<App[]>('/api/apps', []),
      fetchAuthed<string[]>('/api/kids', []),
      fetchJson<ScheduleFile>('/data/schedule.json', { items: {} }),
    ]);
    setSchedule(sched.items || {});
    setChFile({ ...ch, channels: Array.isArray(ch.channels) ? ch.channels : [] });
    setPlaylists(pl.playlists || []);
    setApps(all.slice().sort((a, b) => a.label.localeCompare(b.label)));
    setKids(kidList);
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const run = async (work: () => Promise<void>, fail: string) => {
    setBusy(true);
    try { await work(); } catch (e) { alert(friendlyServerError(e, fail)); await load(); } finally { setBusy(false); }
  };

  // channels: kept in data/channels.json; other fields of each channel (icon, category, source) are preserved
  const saveChannels = (channels: Channel[]) => run(async () => {
    setChFile((f) => ({ ...f, channels }));
    await writeJsonToServer('/data', 'channels.json', { ...chFile, version: chFile.version || 1, channels });
  }, 'فشل حفظ القنوات (رقم القناة أرقام فقط أو رابط http/https، والاسم حتى 60 حرفًا).');

  const addChannel = (e: React.FormEvent) => {
    e.preventDefault();
    const value = newChId.trim(), name = newChName.trim();
    // a provider number, or a direct stream link (free channel, no account): it gets its own "u..." id
    const isUrl = /^https?:\/\/\S{4,500}$/i.test(value);
    if ((!isUrl && !/^\d{1,10}$/.test(value)) || !name) { alert('أدخل رقم القناة أو رابطها المباشر (http/https)، والاسم'); return; }
    if (chFile.channels.some((c) => (isUrl ? c.url === value : c.id === value))) { alert('القناة مضافة مسبقًا'); return; }
    const ch: Channel = isUrl
      ? { id: 'u' + Math.random().toString(36).slice(2, 10).padEnd(8, '0'), name, icon: '', url: value }
      : { id: value, name, icon: '' };
    saveChannels([...chFile.channels, ch]);
    setNewChId('');
    setNewChName('');
  };

  // channel logo from the phone (UX-AUDIT K3): redrawn to 512 px (drops metadata), stored in user_icons/
  const uploadChannelIcon = (i: number, file: File | undefined) => {
    if (!file) return;
    run(async () => {
      const clean = await prepareImage(file, 512);
      const name = `ch_${chFile.channels[i].id}_${Date.now().toString(36)}.${imageExtension(clean)}`;
      await uploadToServer('/user_icons', new File([clean], name, { type: clean.type }), name);
      const channels = chFile.channels.map((c, k) => (k === i ? { ...c, icon: 'user_icons/' + name } : c));
      await writeJsonToServer('/data', 'channels.json', { ...chFile, version: chFile.version || 1, channels });
      setChFile((f) => ({ ...f, channels }));
    }, 'تعذر رفع الشعار (JPG / PNG / WEBP).');
  };

  const commitChannelName = () => {
    if (chEdit === null) return;
    const name = chEditName.trim();
    if (name) saveChannels(chFile.channels.map((c, i) => (i === chEdit ? { ...c, name } : c)));
    setChEdit(null);
  };

  // playlists: the TV keeps data/playlists.json (POST /api/playlists cleans and stamps it)
  const savePlaylists = (next: Playlist[]) => run(async () => {
    setPlaylists(next);
    await postAuthed('/api/playlists', JSON.stringify({ playlists: next }));
  }, 'فشل حفظ القوائم.');

  const addPlaylist = (e: React.FormEvent) => {
    e.preventDefault();
    const id = playlistIdFrom(plUrl);
    if (!id) { setPlMsg('الرابط لا يحتوي قائمة تشغيل (list=...)'); return; }
    if (playlists.some((p) => p.id === id)) { setPlMsg('القائمة مضافة مسبقًا'); return; }
    setPlMsg('');
    savePlaylists([...playlists, { id, name: plName.trim() }]);
    setPlUrl('');
    setPlName('');
  };

  const refreshYoutube = () => run(async () => {
    await postAuthed('/api/youtube/refresh', '');
    setPlMsg('سيحدّث التلفزيون الفيديوهات خلال 5 دقائق ✅');
  }, 'تعذر طلب التحديث.');

  // child's apps: order = order in the "programs" row on the TV
  const saveKids = (next: string[]) => run(async () => {
    setKids(next);
    await postAuthed('/api/kids', next.join(','));
  }, 'فشل حفظ برامج الطفل.');

  const saveTimes = (key: string, wins: TimeWindow[]) => run(async () => {
    const items = { ...schedule };
    if (wins.length) items[key] = wins; else delete items[key];
    setSchedule(items);
    await writeJsonToServer('/data', 'schedule.json', { items, updatedAt: new Date().toISOString() });
    setTimeKey(null);
  }, 'فشل حفظ الأوقات.');

  // ⏰ button + summary for one item; the editor opens below its row
  const timeButton = (key: string) => (
    <button onClick={() => setTimeKey(timeKey === key ? null : key)} className={`${iconBtn} ${schedule[key]?.length ? 'text-amber-400' : 'text-slate-400'}`} aria-label="أوقات المشاهدة">
      <Clock className="w-5 h-5" />
    </button>
  );
  const timeEditor = (key: string) => timeKey === key && (
    <ScheduleEditor value={schedule[key]} busy={busy} onSave={(w) => saveTimes(key, w)} onCancel={() => setTimeKey(null)} />
  );

  const labelOf = (pkg: string) => apps.find((a) => a.pkg === pkg)?.label || pkg;
  const notChosen = apps.filter((a) => !kids.includes(a.pkg));

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* --- channels --- */}
      <section className={card}>
        <h2 className="text-lg sm:text-xl font-bold mb-2 flex items-center gap-2 text-sky-400">
          <Tv className="w-5 h-5 sm:w-6 sm:h-6" /> القنوات التلفزيونية
          <span className="text-sm text-slate-500 font-normal mr-auto">{chFile.channels.length}</span>
        </h2>
        <p className="text-xs text-slate-500 mb-4 leading-6">الترتيب هنا هو ترتيبها على شاشة الطفل. رقم القناة (stream id) من قائمة المزوّد، أو رابط بث مباشر مجاني (m3u8) لا يحتاج اشتراكًا. اضغط دائرة القناة لرفع شعار لها.</p>
        <div className="space-y-2 mb-4">
          {chFile.channels.map((c, i) => (
            <div key={c.id} className="space-y-2">
            <div className={row}>
              <label className="relative w-10 h-10 rounded-full bg-white flex items-center justify-center overflow-hidden shrink-0 cursor-pointer" title="تغيير الشعار">
                {c.icon ? <img src={'/' + String(c.icon).replace(/^\/+/, '')} alt="" className="w-full h-full object-contain" /> : <span>📺</span>}
                <span className="absolute -bottom-0.5 -left-0.5 bg-sky-600 rounded-full p-0.5"><ImagePlus className="w-3 h-3 text-white" /></span>
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" disabled={busy}
                  onChange={(e) => { uploadChannelIcon(i, e.target.files?.[0]); e.target.value = ''; }} />
              </label>
              {chEdit === i ? (
                <>
                  <input value={chEditName} onChange={(e) => setChEditName(e.target.value)} autoFocus maxLength={40}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitChannelName(); if (e.key === 'Escape') setChEdit(null); }}
                    className="flex-1 min-w-0 bg-slate-900 border border-sky-500/50 rounded-lg px-3 py-2 focus:outline-none" />
                  <button onClick={commitChannelName} className={`${iconBtn} text-green-400`} aria-label="حفظ"><Check className="w-5 h-5" /></button>
                  <button onClick={() => setChEdit(null)} className={`${iconBtn} text-slate-400`} aria-label="إلغاء"><X className="w-5 h-5" /></button>
                </>
              ) : (
                <>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate font-medium">{c.name} <span className="text-xs text-slate-500 font-mono" dir="ltr">{typeof c.url === 'string' ? '🔗 رابط مباشر' : c.id}</span></span>
                    <ScheduleSummary wins={schedule['ch:' + c.id]} />
                  </span>
                  {timeButton('ch:' + c.id)}
                  <button disabled={busy || i === 0} onClick={() => saveChannels(move(chFile.channels, i, -1))} className={`${iconBtn} text-slate-400`} aria-label="أعلى"><ChevronUp className="w-5 h-5" /></button>
                  <button disabled={busy || i === chFile.channels.length - 1} onClick={() => saveChannels(move(chFile.channels, i, 1))} className={`${iconBtn} text-slate-400`} aria-label="أسفل"><ChevronDown className="w-5 h-5" /></button>
                  <button onClick={() => { setChEdit(i); setChEditName(c.name); }} className={`${iconBtn} text-blue-400/70`} aria-label="تعديل"><Pencil className="w-5 h-5" /></button>
                  <button disabled={busy} onClick={() => { if (confirm(`حذف "${c.name}"؟`)) saveChannels(chFile.channels.filter((_, k) => k !== i)); }} className={`${iconBtn} text-red-400/60`} aria-label="حذف"><Trash2 className="w-5 h-5" /></button>
                </>
              )}
            </div>
            {timeEditor('ch:' + c.id)}
            </div>
          ))}
          {chFile.channels.length === 0 && <p className="text-slate-500 text-center py-4">لا توجد قنوات</p>}
        </div>
        <form onSubmit={addChannel} className="flex flex-col sm:flex-row gap-2">
          <input value={newChId} onChange={(e) => setNewChId(e.target.value)} placeholder="رقم القناة أو رابط m3u8" dir="ltr" className={`${input} sm:w-56`} />
          <input value={newChName} onChange={(e) => setNewChName(e.target.value)} placeholder="الاسم الظاهر للطفل" maxLength={40} className={`${input} flex-1`} />
          <button type="submit" disabled={busy} className="bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 text-white px-4 py-3 rounded-xl flex items-center justify-center gap-1"><Plus className="w-5 h-5" /> إضافة</button>
        </form>
      </section>

      {/* --- YouTube playlists --- */}
      <section className={card}>
        <h2 className="text-lg sm:text-xl font-bold mb-2 flex items-center gap-2 text-red-400">
          <Youtube className="w-5 h-5 sm:w-6 sm:h-6" /> قوائم يوتيوب الإضافية
          <button onClick={refreshYoutube} disabled={busy} className="mr-auto flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 disabled:opacity-50 px-3 py-1.5 rounded-lg">
            <RefreshCw className="w-4 h-4" /> تحديث الفيديوهات على التلفزيون
          </button>
        </h2>
        <p className="text-xs text-slate-500 mb-4 leading-6">القائمة الأساسية تظهر فيديوهاتها مباشرة. كل قائمة هنا تظهر كدائرة 📂 في صف يوتيوب. يجب أن تكون القائمة عامة أو غير مدرجة.</p>
        <div className="space-y-2 mb-4">
          <div className="space-y-2">
            <div className={row}>
              <span className="flex-1 min-w-0">
                <span className="block truncate font-medium">▶️ القائمة الأساسية (فيديوهات الصف)</span>
                <ScheduleSummary wins={schedule['yt:main']} />
              </span>
              {timeButton('yt:main')}
            </div>
            {timeEditor('yt:main')}
          </div>
          {playlists.map((p, i) => (
            <div key={p.id} className="space-y-2">
            <div className={row}>
              <span className="flex-1 min-w-0">
                <span className="block truncate font-medium">📂 {p.name || '(الاسم من يوتيوب)'}</span>
                <ScheduleSummary wins={schedule['yt:' + p.id]} />
              </span>
              {timeButton('yt:' + p.id)}
              <button disabled={busy || i === 0} onClick={() => savePlaylists(move(playlists, i, -1))} className={`${iconBtn} text-slate-400`} aria-label="أعلى"><ChevronUp className="w-5 h-5" /></button>
              <button disabled={busy} onClick={() => { if (confirm('حذف القائمة؟')) savePlaylists(playlists.filter((_, k) => k !== i)); }} className={`${iconBtn} text-red-400/60`} aria-label="حذف"><Trash2 className="w-5 h-5" /></button>
            </div>
            {timeEditor('yt:' + p.id)}
            </div>
          ))}
          {playlists.length === 0 && <p className="text-slate-500 text-center py-4">لا توجد قوائم إضافية</p>}
        </div>
        <form onSubmit={addPlaylist} className="space-y-2">
          <input value={plUrl} onChange={(e) => setPlUrl(e.target.value)} placeholder="رابط القائمة (فيه list=...)" dir="ltr" className={`${input} w-full`} />
          <div className="flex gap-2">
            <input value={plName} onChange={(e) => setPlName(e.target.value)} placeholder="الاسم الظاهر للطفل (اختياري)" maxLength={60} className={`${input} flex-1 min-w-0`} />
            <button type="submit" disabled={busy || !plUrl.trim()} className="bg-red-600 hover:bg-red-500 disabled:bg-slate-700 text-white px-4 rounded-xl flex items-center gap-1"><Plus className="w-5 h-5" /> إضافة</button>
          </div>
          {plMsg && <p className="text-sm text-slate-300">{plMsg}</p>}
        </form>
      </section>

      {/* --- child's apps --- */}
      <section className={card}>
        <h2 className="text-lg sm:text-xl font-bold mb-2 flex items-center gap-2 text-emerald-400">
          <Puzzle className="w-5 h-5 sm:w-6 sm:h-6" /> برامج الطفل
          <span className="text-sm text-slate-500 font-normal mr-auto">{kids.length}</span>
        </h2>
        <p className="text-xs text-slate-500 mb-4 leading-6">تظهر في صف «البرامج» بهذا الترتيب. في واجهة الأطفال يرفض التلفزيون فتح أي تطبيق غيرها.</p>
        <div className="space-y-2 mb-5">
          {kids.map((pkg, i) => (
            <div key={pkg} className={row}>
              <img src={appIcon(pkg)} alt="" className="w-14 h-8 object-contain bg-white rounded shrink-0" loading="lazy" />
              <span className="flex-1 min-w-0 truncate font-medium">{labelOf(pkg)}</span>
              <button disabled={busy || i === 0} onClick={() => saveKids(move(kids, i, -1))} className={`${iconBtn} text-slate-400`} aria-label="أعلى"><ChevronUp className="w-5 h-5" /></button>
              <button disabled={busy || i === kids.length - 1} onClick={() => saveKids(move(kids, i, 1))} className={`${iconBtn} text-slate-400`} aria-label="أسفل"><ChevronDown className="w-5 h-5" /></button>
              <button disabled={busy} onClick={() => saveKids(kids.filter((p) => p !== pkg))} className={`${iconBtn} text-red-400/60`} aria-label="إخفاء"><Trash2 className="w-5 h-5" /></button>
            </div>
          ))}
          {kids.length === 0 && <p className="text-slate-500 text-center py-4">لا توجد برامج ظاهرة للطفل</p>}
        </div>
        <h3 className="text-sm font-bold text-slate-300 mb-2 flex items-center gap-2"><Plus className="w-4 h-4" /> إظهار تطبيق للطفل</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
          {notChosen.map((a) => (
            <button key={a.pkg} disabled={busy} onClick={() => saveKids([...kids, a.pkg])}
              className="flex items-center gap-2 bg-slate-950 hover:bg-emerald-500/10 border border-white/5 rounded-lg px-3 py-2 text-right transition-colors">
              <img src={appIcon(a.pkg)} alt="" className="w-12 h-7 object-contain bg-white rounded shrink-0" loading="lazy" />
              <span className="flex-1 min-w-0 truncate font-medium">{a.label}</span>
            </button>
          ))}
          {apps.length === 0 && <p className="text-slate-500 text-sm col-span-2 py-2">تعذر جلب قائمة التطبيقات من التلفزيون.</p>}
        </div>
      </section>

      {/* --- streaming account, servers, YouTube key (config.json) --- */}
      <StreamSettings />
    </div>
  );
}
