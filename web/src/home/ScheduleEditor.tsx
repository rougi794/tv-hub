// Phone admin: viewing-time editor for one kids item (channel or playlist). See src/shared/schedule.ts.
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { DAY_SHORT, describeWindow, validWindow, type TimeWindow } from '../shared/schedule';

/** One-line summary under an item: "متاح دائمًا" or its windows. */
export function ScheduleSummary({ wins }: { wins?: TimeWindow[] }) {
  const list = (wins || []).filter(validWindow);
  return (
    <span className={`block text-xs ${list.length ? 'text-amber-300' : 'text-slate-500'}`}>
      {list.length ? '⏰ ' + list.map(describeWindow).join(' · ') : 'متاح دائمًا'}
    </span>
  );
}

export default function ScheduleEditor({ value, onSave, onCancel, busy }: {
  value?: TimeWindow[];
  onSave: (wins: TimeWindow[]) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [wins, setWins] = useState<TimeWindow[]>(() => (value || []).map((w) => ({ ...w, days: w.days ? [...w.days] : [] })));
  const [error, setError] = useState('');

  const update = (i: number, patch: Partial<TimeWindow>) => setWins((list) => list.map((w, k) => (k === i ? { ...w, ...patch } : w)));
  const toggleDay = (i: number, d: number) => {
    const days = wins[i].days || [];
    update(i, { days: days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort() });
  };

  const save = () => {
    if (wins.some((w) => !validWindow(w))) { setError('أكمل وقت البداية والنهاية لكل فترة (ولا يتساويان)'); return; }
    // all seven days selected = every day: store it as "no day filter"
    onSave(wins.map((w) => ({ from: w.from, to: w.to, ...(w.days && w.days.length && w.days.length < 7 ? { days: w.days } : {}) })));
  };

  return (
    <div className="bg-slate-900 border border-amber-500/30 rounded-xl p-3 space-y-3">
      <p className="text-xs text-slate-400 leading-5">
        خارج هذه الأوقات يظهر العنصر مقفلًا 🔒 للطفل، ويتوقف التشغيل عند انتهاء الوقت. بلا فترات = متاح دائمًا. الأيام غير المحددة = كل الأيام.
      </p>
      {wins.map((w, i) => (
        <div key={i} className="bg-slate-950 rounded-lg p-2 space-y-2 border border-white/5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm">من</span>
            <input type="time" value={w.from} onChange={(e) => update(i, { from: e.target.value })} dir="ltr"
              className="bg-slate-900 border border-white/10 rounded-lg px-2 py-1.5" />
            <span className="text-sm">إلى</span>
            <input type="time" value={w.to} onChange={(e) => update(i, { to: e.target.value })} dir="ltr"
              className="bg-slate-900 border border-white/10 rounded-lg px-2 py-1.5" />
            <button onClick={() => setWins((l) => l.filter((_, k) => k !== i))} className="mr-auto text-red-400/70 hover:text-red-400 p-1.5" aria-label="حذف الفترة">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {DAY_SHORT.map((name, d) => {
              const on = (w.days || []).includes(d);
              return (
                <button key={d} onClick={() => toggleDay(i, d)}
                  className={`text-xs px-2 py-1 rounded-md border ${on ? 'bg-amber-500/20 border-amber-400 text-amber-200' : 'border-white/10 text-slate-400'}`}>
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <button onClick={() => setWins((l) => [...l, { from: '16:00', to: '19:00', days: [] }])}
        className="flex items-center gap-1 text-sm text-amber-300 hover:text-amber-200">
        <Plus className="w-4 h-4" /> إضافة فترة
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button disabled={busy} onClick={save} className="bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 text-white font-bold px-4 py-2 rounded-lg">حفظ الأوقات</button>
        <button onClick={onCancel} className="text-slate-400 hover:text-white px-3 py-2">إلغاء</button>
      </div>
    </div>
  );
}
