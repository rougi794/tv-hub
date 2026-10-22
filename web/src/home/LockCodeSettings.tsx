// Phone admin, "home" tab: the 4-digit code of the dashboard's lock screen (config.json security.pinCode).
// config.json is inside the TV app since v41, so this is the way to change it. Write-only like the other secrets:
// the TV only says whether it is still the default 1234.
import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { fetchAuthed, friendlyServerError, normalizeSecret, postAuthedJson } from './adminApi';

export default function LockCodeSettings() {
  const [isDefault, setIsDefault] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchAuthed<{ ok?: boolean; lockDefault?: boolean } | null>('/api/config', null)
      .then((v) => { if (v && v.ok) setIsDefault(!!v.lockDefault); });
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = normalizeSecret(code);
    if (!/^\d{4}$/.test(c)) { setMsg('❌ الرمز 4 أرقام'); return; }
    setBusy(true);
    setMsg('');
    try {
      const v = await postAuthedJson<{ lockDefault?: boolean }>('/api/config', { lockCode: c });
      setIsDefault(!!v.lockDefault);
      setCode('');
      setMsg('✅ تم الحفظ. يُطبَّق على شاشة القفل خلال 10 دقائق أو عند إعادة تشغيل التلفاز.');
    } catch (err) {
      setMsg('❌ ' + friendlyServerError(err, 'تعذر الحفظ'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-slate-900/50 p-4 sm:p-6 rounded-2xl border border-white/10 shadow-xl">
      <h2 className="text-lg sm:text-xl font-bold mb-2 flex items-center gap-2 text-rose-400">
        <Lock className="w-5 h-5 sm:w-6 sm:h-6" /> رمز قفل اللوحة
      </h2>
      <p className="text-xs text-slate-400 mb-4 leading-6">
        الرمز الذي يفتح شاشة القفل على التلفزيون (4 أرقام).
        {isDefault === true && <span className="text-amber-400"> ما زال الرمز الافتراضي 1234، يُنصح بتغييره.</span>}
        {isDefault === false && <span className="text-emerald-400"> تم تعيين رمز خاص.</span>}
      </p>
      <form onSubmit={save} className="flex gap-2">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="رمز جديد من 4 أرقام" inputMode="numeric"
          type="password" autoComplete="new-password" maxLength={4} dir="ltr"
          className="flex-1 bg-slate-950 border border-white/10 rounded-xl px-4 py-3 focus:outline-none focus:border-rose-500/50" />
        <button type="submit" disabled={busy || !code} className="bg-rose-600 hover:bg-rose-500 disabled:bg-slate-700 text-white px-5 rounded-xl">
          حفظ
        </button>
      </form>
      {msg && <p className="mt-3 text-sm">{msg}</p>}
    </section>
  );
}
