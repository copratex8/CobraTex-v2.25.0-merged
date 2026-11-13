/** دوال صافية للحضور والإجازات (قابلة للاختبار بلا قاعدة بيانات). */
export interface Punch { workerCode: string; timestamp: string } // 'YYYY-MM-DD HH:MM' أو 'YYYY-MM-DDTHH:MM'
export interface DayPunch { workerCode: string; date: string; checkIn: string; checkOut?: string; singlePunch: boolean }

const parse = (ts: string) => { const m = /^(\d{4}-\d{2}-\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)/.exec(ts.trim()); return m ? { date: m[1], time: `${m[2]}:${m[3]}` } : null; };

/** يجمّع بصمات اليوم الواحد لكل عامل: أول بصمة = دخول، آخر بصمة = خروج (بصمة واحدة = دخول فقط). البصمات غير الصالحة تُعاد في invalid. */
export function groupPunches(punches: Punch[]): { days: DayPunch[]; invalid: string[] } {
  const map = new Map<string, string[]>(); const invalid: string[] = [];
  for (const p of punches) {
    const t = parse(p.timestamp);
    if (!t || !p.workerCode?.trim()) { invalid.push(`${p.workerCode ?? '?'} @ ${p.timestamp}`); continue; }
    const k = `${p.workerCode.trim()}|${t.date}`;
    (map.get(k) ?? map.set(k, []).get(k)!).push(t.time);
  }
  const days: DayPunch[] = [];
  for (const [k, times] of map) {
    const [workerCode, date] = k.split('|'); times.sort();
    days.push({ workerCode, date, checkIn: times[0], checkOut: times.length > 1 && times[times.length - 1] !== times[0] ? times[times.length - 1] : undefined, singlePunch: times.length === 1 || times[times.length - 1] === times[0] });
  }
  return { days: days.sort((a, b) => a.date.localeCompare(b.date) || a.workerCode.localeCompare(b.workerCode)), invalid };
}

/** دقائق التأخر عن بداية الوردية بعد فترة السماح. */
export function lateMinutes(checkIn: string, shiftStart: string, graceMinutes = 0): number {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return Math.max(0, m(checkIn) - m(shiftStart) - graceMinutes);
}

/** استحقاق الإجازة للسنة: كامل السنة، أو بالتناسب بالأشهر المتبقية لمن عُيّن خلالها (يُقرَّب لأقرب نصف يوم). */
export function leaveEntitlement(annualDays: number, hireDate: string | null, year: number): number {
  if (!hireDate) return annualDays;
  const y = Number(hireDate.slice(0, 4)); const mo = Number(hireDate.slice(5, 7));
  if (y > year) return 0;
  if (y < year) return annualDays;
  return Math.round(((annualDays * (13 - mo)) / 12) * 2) / 2;
}
