// Phone admin, "kids" tab: streaming servers, provider account and YouTube key (config.json on the TV).
// The account and the key are write-only: the TV answers only whether they are set, never their value.
import { useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Plus, Server, Settings, Trash2, XCircle } from 'lucide-react';
import { fetchAuthed, friendlyServerError, NeedPassword, postAuthedJson } from './adminApi';

interface View { baseUrl: string; baseUrls: string[]; credsSet: boolean; keySet: boolean; playlistId: string }
interface TestResult {
  servers: { base: string; ok: boolean; ms?: number; note: string }[];
  youtube: { ok: boolean; note: string };
}

const card = 'bg-slate-900/50 p-4 sm:p-6 rounded-2xl border border-white/10 shadow-xl';
const input = 'w-full bg-slate-950 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-sky-500/50';
const label = 'block text-sm text-slate-400 mb-1';
const small = 'text-xs px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-40';

export default function StreamSettings() {
  const [view, setView] = useState<View | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [backups, setBackups] = useState<string[]>([]);
  const [editCreds, setEditCreds] = useState(false);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [clearCreds, setClearCreds] = useState(false);
  const [editKey, setEditKey] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [playlistId, setPlaylistId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);

  const apply = (v: View) => {
    setView(v);
    setBaseUrl(v.baseUrl);
    setBackups(v.baseUrls || []);
    setPlaylistId(v.playlistId);
    setEditCreds(false); setUser(''); setPass(''); setClearCreds(false);
    setEditKey(false); setApiKey(''); setClearKey(false);
  };

  useEffect(() => {
    fetchAuthed<(View & { ok?: boolean }) | null>('/api/config', null).then((v) => { if (v && v.ok) apply(v); });
  }, []);

  // the changes as the TV expects them; empty secrets mean "keep the saved ones"
  const payload = () => ({
    baseUrl: baseUrl.trim(),
    baseUrls: backups.map((b) => b.trim()).filter(Boolean),
    playlistId: playlistId.trim(),
    ...(clearCreds ? { clearCreds: true } : editCreds ? { username: user.trim(), password: pass } : {}),
    ...(clearKey ? { clearKey: true } : editKey ? { apiKey: apiKey.trim() } : {}),
  });

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMsg('');
    try { await work(); } catch (e) { setMsg('❌ ' + friendlyServerError(e, 'تعذر الاتصال بالتلفاز')); } finally { setBusy(false); }
  };

  /**
   * Sends the request; when the TV asks for the phone admin password (new server while an account is saved,
   * AUDIT-3 S3), asks for it once and sends again. A wrong password counts towards the TV's lockout.
   */
  const send = async <T,>(url: string): Promise<T> => {
    try {
      return await postAuthedJson<T>(url, payload());
    } catch (e) {
      if (!(e instanceof NeedPassword)) throw e;
      const pass = window.prompt('لإرسال حساب المزوّد إلى خادم جديد، اكتب كلمة مرور صفحة الجوال:');
      if (!pass) throw new Error('أُلغي: تغيير الخوادم يحتاج كلمة المرور');
      try {
        return await postAuthedJson<T>(url, payload(), pass);
      } catch (e2) {
        if (e2 instanceof NeedPassword) throw new Error('كلمة المرور غير صحيحة');
        throw e2;
      }
    }
  };

  const doTest = () => run(async () => {
    setTest(null);
    setTest(await send<TestResult>('/api/config/test'));
  });

  const doSave = () => run(async () => {
    if (editCreds && !clearCreds && (!user.trim() || !pass)) { setMsg('❌ أدخل اسم المستخدم وكلمة المرور معًا'); return; }
    const v = await send<View>('/api/config');
    apply(v);
    setMsg('✅ تم الحفظ. القنوات تستخدم الإعداد الجديد من التشغيل التالي، وقوائم يوتيوب تتحدث خلال دقائق.');
  });

  if (!view) {
    return (
      <section className={card}>
        <p className="text-slate-500 text-center py-4">...تحميل إعدادات البث</p>
      </section>
    );
  }

  const status = (ok: boolean, text: string) => (
    <span className={`inline-flex items-center gap-1 text-sm ${ok ? 'text-emerald-400' : 'text-slate-500'}`}>
      {ok ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />} {text}
    </span>
  );

  return (
    <section className={card}>
      <h2 className="text-lg sm:text-xl font-bold mb-2 flex items-center gap-2 text-amber-400">
        <Settings className="w-5 h-5 sm:w-6 sm:h-6" /> إعدادات البث ويوتيوب
      </h2>
      <p className="text-xs text-slate-500 mb-4 leading-6">
        اسم المستخدم وكلمة المرور ومفتاح يوتيوب تُحفظ في التلفاز ولا تُعرض هنا أبدًا. صفحة الجوال تعمل داخل شبكة البيت بلا تشفير، فاحفظها من شبكتك فقط.
        القنوات المجانية (رابط m3u8) لا تحتاج شيئًا من هذا.
      </p>

      {/* servers */}
      <div className="space-y-3 mb-5">
        <div>
          <label className={label}><Server className="inline w-4 h-4 ml-1" />الخادم الرئيسي</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://server:port" dir="ltr" className={input} />
        </div>
        <div>
          <label className={label}>خوادم احتياطية (للمزوّد نفسه)</label>
          <div className="space-y-2">
            {backups.map((b, i) => (
              <div key={i} className="flex gap-2">
                <input value={b} onChange={(e) => setBackups(backups.map((x, k) => (k === i ? e.target.value : x)))} placeholder="http://backup:port" dir="ltr" className={input} />
                <button onClick={() => setBackups(backups.filter((_, k) => k !== i))} className="p-2 text-red-400/70" aria-label="حذف"><Trash2 className="w-5 h-5" /></button>
              </div>
            ))}
            {backups.length < 8 && (
              <button onClick={() => setBackups([...backups, ''])} className={`${small} flex items-center gap-1`}><Plus className="w-4 h-4" /> إضافة خادم احتياطي</button>
            )}
          </div>
        </div>
      </div>

      {/* provider account */}
      <div className="mb-5 p-3 rounded-xl bg-slate-950 border border-white/5">
        <div className="flex items-center gap-2 flex-wrap">
          <KeyRound className="w-4 h-4 text-slate-400" />
          <span className="font-medium">حساب المزوّد:</span>
          {clearCreds ? status(false, 'سيُحذف عند الحفظ') : status(view.credsSet, view.credsSet ? 'محفوظ' : 'غير موجود')}
          <span className="mr-auto flex gap-2">
            <button disabled={busy} onClick={() => { setEditCreds(!editCreds); setClearCreds(false); }} className={small}>{editCreds ? 'إلغاء' : view.credsSet ? 'تغيير' : 'إضافة'}</button>
            {view.credsSet && !editCreds && <button disabled={busy} onClick={() => setClearCreds(!clearCreds)} className={`${small} text-red-400`}>{clearCreds ? 'تراجع' : 'حذف'}</button>}
          </span>
        </div>
        {editCreds && (
          <div className="grid sm:grid-cols-2 gap-2 mt-3">
            <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="اسم المستخدم" dir="ltr" autoComplete="off" autoCapitalize="none" spellCheck={false} className={input} />
            <input value={pass} onChange={(e) => setPass(e.target.value)} placeholder="كلمة المرور" type="password" dir="ltr" autoComplete="new-password" className={input} />
          </div>
        )}
      </div>

      {/* YouTube */}
      <div className="mb-5 p-3 rounded-xl bg-slate-950 border border-white/5 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <KeyRound className="w-4 h-4 text-slate-400" />
          <span className="font-medium">مفتاح YouTube API:</span>
          {clearKey ? status(false, 'سيُحذف عند الحفظ') : status(view.keySet, view.keySet ? 'محفوظ' : 'غير موجود')}
          <span className="mr-auto flex gap-2">
            <button disabled={busy} onClick={() => { setEditKey(!editKey); setClearKey(false); }} className={small}>{editKey ? 'إلغاء' : view.keySet ? 'تغيير' : 'إضافة'}</button>
            {view.keySet && !editKey && <button disabled={busy} onClick={() => setClearKey(!clearKey)} className={`${small} text-red-400`}>{clearKey ? 'تراجع' : 'حذف'}</button>}
          </span>
        </div>
        {editKey && (
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="AIza..." type="password" dir="ltr" autoComplete="off" className={input} />
        )}
        <p className="text-xs text-slate-500 leading-5">بدون مفتاح تبقى القنوات والبرامج تعمل، ولا تظهر فيديوهات يوتيوب.</p>
        <div>
          <label className={label}>القائمة الرئيسية في يوتيوب (اختياري)</label>
          <input value={playlistId} onChange={(e) => setPlaylistId(e.target.value)} placeholder="PL..." dir="ltr" className={input} />
        </div>
      </div>

      <div className="flex gap-2">
        <button disabled={busy} onClick={doTest} className="flex-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white px-4 py-3 rounded-xl">
          {busy ? '...' : 'اختبار الاتصال'}
        </button>
        <button disabled={busy} onClick={doSave} className="flex-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white px-4 py-3 rounded-xl font-bold">
          حفظ
        </button>
      </div>
      {msg && <p className="mt-3 text-sm leading-6">{msg}</p>}

      {test && (
        <div className="mt-4 space-y-2 text-sm">
          <p className="text-slate-400">نتيجة الاختبار (بالإعدادات المكتوبة أعلاه، لم يُحفظ شيء):</p>
          {test.servers.length === 0 && <p className="text-slate-500">لا توجد خوادم.</p>}
          {test.servers.map((s, i) => (
            <div key={i} className="flex items-start gap-2">
              {s.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" /> : <XCircle className="w-4 h-4 mt-0.5 text-red-400 shrink-0" />}
              <span className="min-w-0">
                <span className="block truncate font-mono text-xs text-slate-400" dir="ltr">{i === 0 ? '★ ' : ''}{s.base}</span>
                {s.note}{s.ms ? ` · ${(s.ms / 1000).toFixed(1)} ث` : ''}
              </span>
            </div>
          ))}
          <div className="flex items-start gap-2">
            {test.youtube.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-400 shrink-0" /> : <XCircle className="w-4 h-4 mt-0.5 text-red-400 shrink-0" />}
            <span>يوتيوب: {test.youtube.note}</span>
          </div>
        </div>
      )}
    </section>
  );
}
