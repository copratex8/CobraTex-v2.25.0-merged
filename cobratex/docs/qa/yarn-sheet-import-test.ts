import * as yl from '@/modules/manufacturing/yarnLedger';
import * as fs from 'fs';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission() {}, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
// الحمولة ناتجة من قراءة الشيت الفعلي بقارئ المتصفح (Chromium)؛ القيم المرجعية = القيم المحفوظة في لوحة الشيت نفسه (5150 / 1200 / 25 / 3925).
const data = JSON.parse(fs.readFileSync(process.env.FIX ?? '/tmp/final/yarn-sheet-parsed.json', 'utf8'));
(async () => {
  const d = await yl.importData(ctx, { dryRun: true, receipts: data.receipts, runs: data.runs }); ok(d.errors.length === 0 && d.receipts === 5 && d.runs === 3, 'dry-run clean: 5 receipts, 3 runs');
  const r = await yl.importData(ctx, { dryRun: false, receipts: data.receipts, runs: data.runs }); ok(r.imported, 'imported');
  const L = await yl.ledger(ctx, {}); const n = (a: number, b: number) => Math.abs(a - b) < 0.001;
  ok(n(L.totals.received, 5150), 'total received = sheet 5150'); ok(n(L.totals.net, 1200), 'net = 1200'); ok(n(L.totals.waste, 25), 'waste = 25'); ok(n(L.totals.balance, 3925), 'balance = sheet 3925');
  const l = L.lots.find((x: any) => x.lotNo === 'L-1001'); ok(n(l.received, 3000) && n(l.net, 590) && n(l.waste, 14.2) && n(l.balance, 2395.8), 'L-1001 row equals sheet formulas');
  console.log(`PASS ${pass} FAIL ${fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
