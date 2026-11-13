/** مقارنة إصدارات x.y.z (سالب إن كان a أقدم من b). قيم غير صالحة تُعامَل كـ 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (/^\d+\.\d+\.\d+/.test(v) ? v.split('.').slice(0, 3).map((n) => parseInt(n, 10)) : [0, 0, 0]);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
