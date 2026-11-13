/** قارئ xlsx خفيف بلا مكتبات: zip عبر DecompressionStream + XML عبر DOMParser. يقرأ القيم المحفوظة للمعادلات (cached). */
type Cell = string | number;
export type Sheet = Map<string, Cell>;
const u16 = (d: DataView, o: number) => d.getUint16(o, true); const u32 = (d: DataView, o: number) => d.getUint32(o, true);

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw'); const w = ds.writable.getWriter(); void w.write(raw as BufferSource); void w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
async function unzip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const d = new DataView(buf); const u8 = new Uint8Array(buf); let e = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (u32(d, i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('الملف ليس xlsx صالحًا');
  const n = u16(d, e + 10); let p = u32(d, e + 16); const out = new Map<string, Uint8Array>(); const dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    const method = u16(d, p + 10), csize = u32(d, p + 20), nl = u16(d, p + 28), el = u16(d, p + 30), cl = u16(d, p + 32), lo = u32(d, p + 42); const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + el + cl; if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    const ds = lo + 30 + u16(d, lo + 26) + u16(d, lo + 28); const data = u8.subarray(ds, ds + csize);
    out.set(name, method === 0 ? data : method === 8 ? await inflate(data) : (() => { throw new Error('ضغط غير مدعوم'); })());
  }
  return out;
}
const xml = (b: Uint8Array) => new DOMParser().parseFromString(new TextDecoder().decode(b), 'application/xml');

export async function readWorkbook(buf: ArrayBuffer): Promise<Record<string, Sheet>> {
  const z = await unzip(buf); const wb = xml(z.get('xl/workbook.xml')!); const rels = xml(z.get('xl/_rels/workbook.xml.rels')!);
  const target = new Map<string, string>(); for (const r of Array.from(rels.getElementsByTagName('Relationship'))) target.set(r.getAttribute('Id')!, r.getAttribute('Target')!);
  const sst: string[] = []; const ss = z.get('xl/sharedStrings.xml'); if (ss) for (const si of Array.from(xml(ss).getElementsByTagName('si'))) sst.push(Array.from(si.getElementsByTagName('t')).map((t) => t.textContent ?? '').join(''));
  const res: Record<string, Sheet> = {};
  for (const s of Array.from(wb.getElementsByTagName('sheet'))) {
    const name = s.getAttribute('name')!; const rid = s.getAttribute('r:id') ?? s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')!;
    let t = target.get(rid)!; t = t.startsWith('/') ? t.slice(1) : 'xl/' + t; const data = z.get(t); if (!data) continue;
    const sheet: Sheet = new Map();
    for (const c of Array.from(xml(data).getElementsByTagName('c'))) {
      const ref = c.getAttribute('r')!; const ty = c.getAttribute('t'); const v = c.getElementsByTagName('v')[0]?.textContent; if (v === undefined || v === null) { const is = c.getElementsByTagName('t')[0]?.textContent; if (is) sheet.set(ref, is); continue; }
      if (ty === 's') sheet.set(ref, sst[Number(v)] ?? ''); else if (ty === 'str' || ty === 'inlineStr' || ty === 'e') sheet.set(ref, v); else if (ty === 'b') sheet.set(ref, v === '1' ? 1 : 0); else sheet.set(ref, Number(v));
    }
    res[name] = sheet;
  }
  return res;
}

const iso = (v: Cell | undefined): string | null => { if (v === undefined || v === '') return null; if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10); const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const str = (v: Cell | undefined) => (v === undefined ? '' : String(v).trim()); const numOf = (v: Cell | undefined) => (typeof v === 'number' ? v : v === undefined || v === '' ? NaN : Number(v));

/** يحوّل شيت «Textile Yarn Inventory» إلى حمولة الاستيراد. النسب في الشيت كسور (0.7) فتُحوَّل لمئة؛ وإن كانت مكتوبة بالمئة تُترك. */
export async function parseYarnWorkbook(buf: ArrayBuffer) {
  const wb = await readWorkbook(buf); const inS = wb['حركة الوارد'], outS = wb['حركة المنصرف']; const warnings: string[] = [];
  if (!inS || !outS) throw new Error('لم أجد ورقتي «حركة الوارد» و«حركة المنصرف» — هل هذا شيت الخيوط؟');
  const receipts: Array<{ date: string; receiptNo?: string; lotNo: string; itemName: string; quantity: number; notes?: string }> = [];
  for (let r = 5; r <= 1004; r++) { const lot = str(inS.get(`D${r}`)), qty = numOf(inS.get(`F${r}`)); if (!lot && Number.isNaN(qty)) continue; const date = iso(inS.get(`B${r}`)); const item = str(inS.get(`E${r}`));
    if (!lot || !(qty > 0) || !date || !item) { warnings.push(`الوارد: الصف ${r} ناقص (تاريخ/لوط/صنف/كمية) — تُجوهل`); continue; }
    receipts.push({ date, ...(str(inS.get(`C${r}`)) ? { receiptNo: str(inS.get(`C${r}`)) } : {}), lotNo: lot, itemName: item, quantity: qty, ...(str(inS.get(`G${r}`)) ? { notes: str(inS.get(`G${r}`)) } : {}) }); }
  const runs: Array<{ date: string; machineCode?: string; fabricKg: number; wastePercent: number; lines: Array<{ lotNo: string; itemName?: string; blendPercent: number }> }> = [];
  for (let r = 5; r <= 1004; r++) { const fab = numOf(outS.get(`D${r}`)); if (Number.isNaN(fab) && !str(outS.get(`F${r}`))) continue; const date = iso(outS.get(`B${r}`)); if (!date || !(fab > 0)) { warnings.push(`المنصرف: الصف ${r} ناقص (تاريخ/إجمالي القماش) — تُجوهل`); continue; }
    const slots = [['F', 'G', 'H'], ['K', 'L', 'M'], ['P', 'Q', 'R']].map(([a, b, c]) => ({ lotNo: str(outS.get(`${a}${r}`)), itemName: str(outS.get(`${b}${r}`)), p: numOf(outS.get(`${c}${r}`)) })).filter((s) => s.lotNo && s.p > 0);
    if (!slots.length) { warnings.push(`المنصرف: الصف ${r} بلا لوطات — تُجوهل`); continue; }
    const sum = slots.reduce((s, x) => s + x.p, 0); const asPercent = sum > 1.5; const k = asPercent ? 1 : 100; let w = numOf(outS.get(`E${r}`)); if (Number.isNaN(w)) w = 0;
    runs.push({ date, ...(str(outS.get(`C${r}`)) ? { machineCode: str(outS.get(`C${r}`)) } : {}), fabricKg: fab, wastePercent: Math.round((asPercent ? w : w * 100) * 10000) / 10000, lines: slots.map((s) => ({ lotNo: s.lotNo, ...(s.itemName ? { itemName: s.itemName } : {}), blendPercent: Math.round(s.p * k * 10000) / 10000 })) }); }
  return { receipts, runs, warnings };
}
