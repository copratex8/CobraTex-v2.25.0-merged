import * as http from 'http';
import jwt from 'jsonwebtoken';
import { pool } from '@/db/pool';
import { uploadAttachment, getAttachmentFile, deleteAttachment } from '@/modules/system/attachmentService';
import { mintRealtimeToken } from '@/modules/system/realtimeToken';
import { moveAttachments } from '@/modules/system/attachmentMigration';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission() {}, visibleBranchIds: () => null, assertBranchInScope() {} };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
// خادم Supabase Storage وهمي: يتحقق من الترويسات ويخزّن في الذاكرة
const store = new Map<string, { data: Buffer; mime: string }>(); let failPut = false; const seen: string[] = [];
const srv = http.createServer((req, res) => {
  const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const auth = req.headers.authorization === 'Bearer SERVICE-KEY' && req.headers.apikey === 'SERVICE-KEY'; if (!auth) { res.writeHead(401).end('no'); return; }
    const m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(req.url ?? ''); if (!m) { res.writeHead(404).end(); return; } const key = `${m[1]}/${decodeURIComponent(m[2])}`; seen.push(`${req.method} ${key}`);
    if (req.method === 'POST') { if (failPut) { res.writeHead(500).end('boom'); return; } if (store.has(key)) { res.writeHead(400).end('exists'); return; } store.set(key, { data: Buffer.concat(chunks), mime: String(req.headers['content-type']) }); res.writeHead(200).end('{}'); }
    else if (req.method === 'GET') { const o = store.get(key); if (!o) { res.writeHead(404).end(); return; } res.writeHead(200, { 'Content-Type': o.mime }).end(o.data); }
    else if (req.method === 'DELETE') { store.delete(key); res.writeHead(200).end('{}'); } else res.writeHead(405).end();
  });
});
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const port = (srv.address() as any).port;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); const pdf = Buffer.from('%PDF-1.4 test-document-' + 'x'.repeat(200));
  const up = (data: Buffer, mime = 'image/png', name = 'صورة الفاتورة.png') => uploadAttachment(ctx, { branchId: Z('0000000000b1'), entityType: 'item', entityId: Z('000000000101'), fileName: name, mimeType: mime, fileData: data });

  // 1) بلا Storage: يعمل كما كان (BYTEA)
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const a0 = await up(png); const r0 = (await q(`SELECT storage_path, octet_length(file_data) AS n FROM attachments WHERE id=$1`, [a0.id])).rows[0]; ok(r0.storage_path === null && Number(r0.n) === png.length, 'without storage: stored in DB as before');
  const legacy = await up(pdf, 'application/pdf', 'legacy.pdf');

  // 2) مع Storage
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`; process.env.SUPABASE_SERVICE_ROLE_KEY = 'SERVICE-KEY';
  const a1 = await up(png); const r1 = (await q(`SELECT storage_path, file_data FROM attachments WHERE id=$1`, [a1.id])).rows[0];
  ok(r1.storage_path === `${ctx.companyId}/item/${a1.id}.png` && r1.file_data === null, 'with storage: path {company}/{type}/{id}.png, file_data NULL (no Arabic filename in path)'); ok(store.has(`attachments/${r1.storage_path}`), 'object exists in storage');
  const got = await getAttachmentFile(ctx, a1.id); ok(Buffer.isBuffer(got.file_data) && got.file_data.equals(png) && got.mime_type === 'image/png', 'download returns exact bytes through API');
  ok((await q(`SELECT 1 FROM attachments WHERE id=$1 AND company_id=$2`, [a1.id, Z('0000000000ff')])).rows.length === 0, 'row scoped by company');
  await rej(() => getAttachmentFile({ ...ctx, companyId: Z('0000000000ff') }, a1.id), /غير موجود/, 'other company cannot download');
  // فشل الرفع: لا صف يتيم
  const before = Number((await q(`SELECT count(*)::int AS n FROM attachments`)).rows[0].n); failPut = true; await rej(() => up(png), /فشل رفع/, 'storage failure surfaces'); failPut = false;
  ok(Number((await q(`SELECT count(*)::int AS n FROM attachments`)).rows[0].n) === before, 'no orphan row after failed upload');
  // فشل التسجيل: لا كائن يتيم (كيان غير موجود يفشل قبل الرفع؛ نفرض فشل INSERT بـ mime/كيان صالح لكن قيد CHECK)
  const sizeBefore = store.size; await rej(() => uploadAttachment(ctx, { branchId: Z('0000000000b1'), entityType: 'item', entityId: Z('0000000000ee'), fileName: 'x.png', mimeType: 'image/png', fileData: png }), /غير موجود/, 'unknown entity refused before any upload'); ok(store.size === sizeBefore, 'no object uploaded for refused request');
  // حذف
  await deleteAttachment(ctx, a1.id); ok(!store.has(`attachments/${r1.storage_path}`) && (await q(`SELECT 1 FROM attachments WHERE id=$1`, [a1.id])).rows.length === 0, 'delete removes row and object');
  // مرفق قديم BYTEA لا يزال يُقرأ بعد تفعيل Storage
  const lg = await getAttachmentFile(ctx, legacy.id); ok(lg.file_data !== null, 'legacy BYTEA still readable with storage enabled');
  await deleteAttachment(ctx, legacy.id).catch(() => undefined); const l2 = await up(pdf, 'application/pdf', 'legacy2.pdf'); await q(`UPDATE attachments SET storage_path=NULL, file_data=decode($2,'hex') WHERE id=$1`, [l2.id, pdf.toString('hex')]);
  // 3) ترحيل القديم
  const dry = await moveAttachments(pool as any, { dryRun: true }); ok(dry.total >= 2 && dry.moved === 0, 'dry-run counts without changing: total=' + dry.total);
  const mv = await moveAttachments(pool as any, { batch: 1 }); ok(mv.failed === 0 && mv.moved === dry.total, `moved all ${dry.total} legacy attachments in batches of 1: ` + JSON.stringify(mv));
  const left = Number((await q(`SELECT count(*)::int AS n FROM attachments WHERE storage_path IS NULL AND file_data IS NOT NULL`)).rows[0].n); ok(left === 0, 'no BYTEA left');
  const after = await getAttachmentFile(ctx, a0.id); ok(after.file_data.equals(png), 'migrated attachment downloads identical bytes'); ok(Number((await q(`SELECT count(*)::int AS n FROM attachments WHERE file_data IS NULL AND storage_path IS NOT NULL`)).rows[0].n) >= 2, 'rows now point to storage');
  await rej(() => q(`INSERT INTO attachments(company_id,branch_id,entity_type,entity_id,file_name,mime_type,file_size) VALUES ($1,$2,'item',$3,'x','image/png',1)`, [ctx.companyId, Z('0000000000b1'), Z('000000000101')]), /./, 'CHECK: a row must have content or storage path');
  // إعادة التشغيل لا تفعل شيئًا
  const again = await moveAttachments(pool as any, {}); ok(again.total === 0 && again.moved === 0, 'idempotent re-run');
  // وصول بلا مفتاح صحيح يفشل
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'WRONG'; await rej(() => getAttachmentFile(ctx, a0.id), /تعذّر قراءة/, 'wrong service key fails safely'); process.env.SUPABASE_SERVICE_ROLE_KEY = 'SERVICE-KEY';

  // 4) توكن Realtime
  delete process.env.SUPABASE_JWT_SECRET; ok(mintRealtimeToken(ctx).enabled === false, 'realtime token disabled without secret');
  process.env.SUPABASE_JWT_SECRET = 'test-secret-test-secret-test-secret-1234'; const t = mintRealtimeToken(ctx, 1_800_000_000) as any; ok(t.enabled && t.expiresIn === 3600 && t.companyId === ctx.companyId, 'token enabled, 1h, returns companyId');
  const claims: any = jwt.verify(t.token, 'test-secret-test-secret-test-secret-1234', { algorithms: ['HS256'], clockTimestamp: 1_800_000_100 }); ok(claims.role === 'authenticated' && claims.aud === 'authenticated' && claims.sub === ctx.userId && claims.app_metadata.company_id === ctx.companyId && claims.company_id === ctx.companyId && claims.tenant_id === ctx.tenantId && claims.exp - claims.iat === 3600, 'claims: role/aud/sub/company_id/ttl');
  let expired = false; try { jwt.verify(t.token, 'test-secret-test-secret-test-secret-1234', { algorithms: ['HS256'], clockTimestamp: 1_800_004_000 }); } catch { expired = true; } ok(expired, 'token expires after 1h');
  let wrong = false; try { jwt.verify(t.token, 'other-secret-other-secret-other-1234', { algorithms: ['HS256'] }); } catch { wrong = true; } ok(wrong, 'rejected with a different secret');
  srv.close(); console.log(`PASS ${pass} FAIL ${fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
