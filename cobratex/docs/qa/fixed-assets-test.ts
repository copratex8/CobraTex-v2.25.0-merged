import * as fa from '@/modules/accounting/fixedAssetService';
import { pool } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string, t = 0.001) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) <= t, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const q = (s: string, p: any[] = []) => pool.query(s, p);
const V = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;
const ac = (id: string, code: string, t: string) => q(`INSERT INTO accounts(id,company_id,code,name_ar,name_en,account_type) VALUES ($1,$2,$3,$3,$3,$4)`, [id, ctx.companyId, code, t]);
const ASSET = V('11'), ACC = V('12'), EXP = V('13'), CASH = V('14'), GL = V('15');
const bal = async (acct: string) => Number((await q(`SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS b FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=$1 AND je.status='posted'`, [acct])).rows[0].b);
(async () => {
  // ===== دوال صرفة =====
  near(fa.monthlyAmount({ cost: 12000, salvage: 0, lifeMonths: 12, method: 'straight_line', accumulated: 0, monthsDone: 0 }), 1000, 'SL monthly 1000');
  near(fa.monthlyAmount({ cost: 1000, salvage: 0, lifeMonths: 3, method: 'straight_line', accumulated: 666.6666, monthsDone: 2 }), 333.3334, 'SL last month takes remainder');
  near(fa.monthlyAmount({ cost: 12000, salvage: 0, lifeMonths: 12, method: 'straight_line', accumulated: 12000, monthsDone: 12 }), 0, 'fully depreciated → 0');
  near(fa.monthlyAmount({ cost: 10000, salvage: 1000, lifeMonths: 24, method: 'declining_balance', accumulated: 0, monthsDone: 0 }), 833.3333, 'DDB month 1');
  near(fa.monthlyAmount({ cost: 10000, salvage: 9000, lifeMonths: 24, method: 'declining_balance', accumulated: 950, monthsDone: 5 }), 50, 'DDB capped at salvage floor');
  const sch = fa.projectSchedule({ cost: 12000, salvage: 0, lifeMonths: 12, method: 'straight_line', accumulated: 0, startMonthEnd: '2026-03-31' });
  ok(sch.length === 12 && sch[0].periodEnd === '2026-03-31' && sch[11].periodEnd === '2027-02-28', 'schedule 12 months Mar-26..Feb-27'); near(sch[11].nbv, 0, 'schedule ends at NBV 0');
  ok(fa.monthEnd(2026, 1) === '2026-02-28' && fa.monthEnd(2028, 1) === '2028-02-29', 'month-end incl. leap year');

  await ac(ASSET, '1500', 'asset'); await ac(ACC, '1590', 'asset'); await ac(EXP, '5100', 'expense'); await ac(CASH, '1100', 'asset'); await ac(GL, '4900', 'revenue');
  const mk = (code: string, date: string, cost: string, salvage: string, life: number, method: any = 'straight_line') => fa.createAsset(ctx, { code, nameAr: 'أصل ' + code, acquisitionDate: date, cost, salvageValue: salvage, usefulLifeMonths: life, method, assetAccountId: ASSET, accumulatedAccountId: ACC, expenseAccountId: EXP });
  // ===== إنشاء وتحقق =====
  await rej(() => mk('X', '2026-03-15', '1000', '1000', 12), /الخردة/, 'salvage ≥ cost rejected');
  await rej(() => fa.createAsset(ctx, { code: 'X', nameAr: 'x', acquisitionDate: '2026-03-15', cost: '1000', usefulLifeMonths: 12, assetAccountId: ASSET, accumulatedAccountId: ACC, expenseAccountId: ASSET } as any), /نوع الحساب/, 'expense account must be expense type');
  await rej(() => fa.createAsset(ctx, { code: 'X', nameAr: 'x', acquisitionDate: '2026-03-15', cost: '1000', usefulLifeMonths: 12, assetAccountId: V('99'), accumulatedAccountId: ACC, expenseAccountId: EXP } as any), /غير موجود/, 'unknown account');
  const A = await mk('A', '2026-03-15', '12000', '0', 12), B = await mk('B', '2026-05-10', '6000', '600', 36), C = await mk('C', '2026-06-05', '10000', '1000', 24, 'declining_balance');
  await rej(() => mk('A', '2026-03-15', '1', '0', 1), /مستخدم/, 'duplicate code');
  denied.add('assets.manage'); await rej(() => mk('Z', '2026-03-15', '1', '0', 1), /DENIED/, 'create perm'); denied.clear();
  const l0 = await fa.listAssets(ctx, {}); near(l0.totals.cost, 28000, 'register cost 28000'); near(l0.totals.netBookValue, 28000, 'NBV = cost before depreciation');

  // ===== معاينة بلا ترحيل =====
  const dry = await fa.runDepreciation(ctx, { through: '2026-06-30', dryRun: true });
  ok(dry.months.length === 4 && dry.posted.length === 0, 'dry run: 4 months, nothing posted'); near(dry.total, 4000 + 300 + 833.3333, 'dry total A4000+B300+C833.3333');
  ok((await q(`SELECT count(*)::int AS n FROM fixed_asset_depreciations`)).rows[0].n === 0, 'dry run wrote no rows');
  // ===== تشغيل حقيقي حتى يونيو (تاريخ منتصف الشهر يُطبَّع لنهاية الشهر) =====
  denied.add('assets.depreciate'); await rej(() => fa.runDepreciation(ctx, { through: '2026-06-15' }), /DENIED/, 'run perm'); denied.clear();
  const r1 = await fa.runDepreciation(ctx, { through: '2026-06-15' });
  ok(r1.posted.length === 4 && r1.posted[3].periodEnd === '2026-06-30', 'posted 4 monthly entries Mar..Jun');
  near(await bal(EXP), 5133.3333, 'expense debit total'); near(await bal(ACC), -5133.3333, 'accumulated credit total');
  const cardA = await fa.assetCard(ctx, A.id); near(cardA.asset.accumulated_depreciation, 4000, 'A accumulated 4000'); near(cardA.asset.net_book_value, 8000, 'A NBV 8000'); ok(cardA.asset.dt_text === '2026-06-30', 'A depreciated through 2026-06-30');
  ok(cardA.history.length === 4 && cardA.schedule.length === 8 && cardA.schedule[0].n === 5, 'A: history 4, remaining schedule 8 starting #5');
  const cardC = await fa.assetCard(ctx, C.id); near(cardC.schedule[0].amount, 763.8889, 'C month 2 = NBV×2/24'); near(cardC.asset.accumulated_depreciation, 833.3333, 'C accumulated');
  const r1b = await fa.runDepreciation(ctx, { through: '2026-06-30' }); ok(r1b.posted.length === 0 && r1b.total === 0, 'idempotent: second run posts nothing');
  // ===== ذرّية: شهر بلا فترة مالية يُلغي التشغيل كله =====
  await rej(() => fa.runDepreciation(ctx, { through: '2027-02-28' }), /لا توجد فترة مالية/, 'missing fiscal period rejects');
  near((await fa.assetCard(ctx, A.id)).asset.accumulated_depreciation, 4000, 'rollback: A unchanged after failed run'); near(await bal(EXP), 5133.3333, 'rollback: no partial entries');
  await q(`INSERT INTO fiscal_periods(id,company_id,start_date,end_date) VALUES ($1,$2,'2027-01-01','2027-12-31')`, [Z('0000000000f3'), ctx.companyId]);
  const r2 = await fa.runDepreciation(ctx, { through: '2027-02-28' }); ok(r2.posted.length === 8, '8 more months Jul-26..Feb-27');
  const a2 = await fa.assetCard(ctx, A.id); near(a2.asset.accumulated_depreciation, 12000, 'A fully depreciated 12000'); ok(a2.asset.status === 'fully_depreciated' && a2.schedule.length === 0, 'A status fully_depreciated, no schedule');
  near((await fa.assetCard(ctx, B.id)).asset.accumulated_depreciation, 1500, 'B 10 months × 150'); ok((await fa.assetCard(ctx, B.id)).asset.status === 'active', 'B still active');
  // ===== عكس شهر =====
  await rej(() => fa.reverseDepreciation(ctx, { periodEnd: '2026-06-30', reason: 'خطأ' }), /لاحق/, 'cannot reverse non-latest month');
  await rej(() => fa.reverseDepreciation(ctx, { periodEnd: '2027-02-28', reason: 'x' }), /3/, 'reason too short');
  const eBefore = await bal(EXP);
  const rv = await fa.reverseDepreciation(ctx, { periodEnd: '2027-02-28', reason: 'تصحيح خطأ إدخال' }); ok(rv.reversed >= 2, 'reversed Feb-27 rows (A,B,C)');
  near(await bal(EXP), eBefore - (1000 + 150 + (await q(`SELECT amount FROM fixed_asset_depreciations WHERE period_end='2027-02-28' AND status='reversed' AND asset_id=$1`, [C.id])).rows[0].amount * 1), 'expense reduced by reversed month');
  const a3 = await fa.assetCard(ctx, A.id); ok(a3.asset.status === 'active' && a3.asset.dt_text === '2027-01-31', 'A back to active, through Jan-27'); near(a3.asset.accumulated_depreciation, 11000, 'A accumulated 11000');
  await rej(() => fa.reverseDepreciation(ctx, { periodEnd: '2027-02-28', reason: 'مرة أخرى' }), /لا إهلاك/, 'cannot reverse twice');
  await fa.runDepreciation(ctx, { through: '2027-02-28' }); near((await fa.assetCard(ctx, A.id)).asset.accumulated_depreciation, 12000, 're-run restores A to 12000');
  // ===== الاستبعاد =====
  await rej(() => fa.disposeAsset(ctx, C.id, { date: '2027-06-10', proceeds: '0', gainLossAccountId: GL }), /شغِّل الإهلاك/, 'dispose requires depreciation up to prior month');
  await rej(() => fa.disposeAsset(ctx, A.id, { date: '2027-03-20', proceeds: '500', gainLossAccountId: GL }), /حساب الحصيلة/, 'proceeds need account');
  await rej(() => fa.disposeAsset(ctx, A.id, { date: '2026-01-01', proceeds: '0', gainLossAccountId: GL }), /يسبق الاقتناء/, 'before acquisition');
  denied.add('assets.dispose'); await rej(() => fa.disposeAsset(ctx, A.id, { date: '2027-03-20', gainLossAccountId: GL }), /DENIED/, 'dispose perm'); denied.clear();
  const dA = await fa.disposeAsset(ctx, A.id, { date: '2027-03-20', proceeds: '500', proceedsAccountId: CASH, gainLossAccountId: GL });
  near(dA.nbvAtDisposal, 0, 'A NBV 0 at disposal'); near(dA.gainLoss, 500, 'A gain 500'); near(await bal(CASH), 500, 'cash debited 500'); near(await bal(GL), -500, 'gain credited 500');
  const dB = await fa.disposeAsset(ctx, B.id, { date: '2027-03-20', proceeds: '3000', proceedsAccountId: CASH, gainLossAccountId: GL });
  near(dB.nbvAtDisposal, 4500, 'B NBV 4500'); near(dB.gainLoss, -1500, 'B loss 1500'); near(await bal(CASH), 3500, 'cash total 3500'); near(await bal(GL), -500 + 1500, 'GL net: gain 500, loss 1500');
  await rej(() => fa.disposeAsset(ctx, A.id, { date: '2027-04-01', gainLossAccountId: GL }), /بالفعل/, 'double dispose');
  near(await bal(ASSET), -18000, 'asset account credited with disposed costs A+B (acquisition entry is booked outside the register)');
  const cAcc = Number((await fa.assetCard(ctx, C.id)).asset.accumulated_depreciation); near(await bal(ACC), -cAcc, 'accumulated account = C only after disposals');
  const l1 = await fa.listAssets(ctx, {}); near(l1.totals.cost, 10000, 'register totals exclude disposed'); ok(l1.assets.length === 3 && (await fa.listAssets(ctx, { status: 'disposed' })).assets.length === 2, 'status filter: 2 disposed');
  const r3 = await fa.runDepreciation(ctx, { through: '2027-03-31' }); ok(r3.months.length === 1 && Math.abs(r3.total - Number((await fa.assetCard(ctx, C.id)).history.slice(-1)[0].amount)) < 0.001, 'only C depreciates after disposals');
  denied.add('assets.view'); await rej(() => fa.listAssets(ctx, {}), /DENIED/, 'view perm'); denied.clear();
  // ===== قيد الاقتناء الاختياري =====
  const before = await bal(ASSET);
  const D = await fa.createAsset(ctx, { code: 'D', nameAr: 'د', acquisitionDate: '2026-02-10', cost: '5000', usefulLifeMonths: 10, assetAccountId: ASSET, accumulatedAccountId: ACC, expenseAccountId: EXP, acquisitionCreditAccountId: CASH } as any);
  ok(!!D.acquisition_entry_id, 'acquisition entry id stored'); near(await bal(ASSET), before + 5000, 'asset account debited 5000'); near(await bal(CASH), 3500 - 5000, 'cash credited 5000');
  const E = await mk('E', '2026-02-10', '100', '0', 10); ok(!E.acquisition_entry_id, 'no entry unless requested'); near(await bal(ASSET), before + 5000, 'no extra posting for E');
  await rej(() => fa.createAsset(ctx, { code: 'F', nameAr: 'ف', acquisitionDate: '2026-02-10', cost: '100', usefulLifeMonths: 10, assetAccountId: ASSET, accumulatedAccountId: ACC, expenseAccountId: EXP, acquisitionCreditAccountId: EXP } as any), /نوع الحساب/, 'credit account type validated');
  await rej(() => fa.createAsset(ctx, { code: 'G', nameAr: 'ج', acquisitionDate: '2030-02-10', cost: '100', usefulLifeMonths: 10, assetAccountId: ASSET, accumulatedAccountId: ACC, expenseAccountId: EXP, acquisitionCreditAccountId: CASH } as any), /لا توجد فترة مالية/, 'no fiscal period → rejected');
  ok((await q(`SELECT count(*)::int AS n FROM fixed_assets WHERE code='G'`)).rows[0].n === 0, 'atomic: failed posting leaves no asset row');
  console.log(`PASS ${pass} FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message || e); process.exit(1); });
