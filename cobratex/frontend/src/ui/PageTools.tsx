import { toast } from '@/ui/toast';

/**
 * أدوات التقرير العامة (٢.١٤.٠): تصدير CSV وExcel وطباعة/PDF لأي شاشة — تقرأ كل الجداول المعروضة في المحتوى
 * مباشرةً من الـDOM، فتعمل على كل الشاشات الحالية والمستقبلية (بما فيها الإضافات) دون تعديل أي صفحة.
 */
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export function collectTables(root: ParentNode = document): Array<{ title: string; rows: string[][] }> {
  const out: Array<{ title: string; rows: string[][] }> = [];
  root.querySelectorAll('main table').forEach((t, i) => {
    const rows: string[][] = [];
    t.querySelectorAll('tr').forEach((tr) => rows.push(Array.from(tr.querySelectorAll('th,td')).map((c) => clean((c as HTMLElement).innerText ?? c.textContent))));
    if (!rows.length || rows.every((r) => r.length === 0)) return;
    // عنوان الجدول: أقرب عنوان سابق داخل نفس البطاقة/القسم
    let title = ''; let el: Element | null = t;
    while (el && !title) { let p: Element | null = el.previousElementSibling; while (p && !title) { const h = p.matches('h1,h2,h3,h4') ? p : p.querySelector('h1,h2,h3,h4'); if (h) title = clean(h.textContent); p = p.previousElementSibling; } el = el.parentElement; if (el?.tagName === 'MAIN') break; }
    out.push({ title: title || `جدول ${i + 1}`, rows });
  });
  return out;
}

const stamp = () => new Date().toISOString().slice(0, 10);
// اسم ملف ASCII دائمًا (بعض المتصفحات تُسقط الامتداد مع الأسماء العربية): يُشتق من مسار الشاشة
const safeName = (_s: string) => (location.pathname.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'report').slice(0, 60);
function download(name: string, mime: string, data: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvCell = (v: string) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function exportCsv(title: string) {
  const tables = collectTables(); if (!tables.length) return toast('لا توجد جداول في هذه الشاشة للتصدير.', 'warn');
  const lines: string[] = [];
  tables.forEach((t, i) => { if (tables.length > 1) { if (i) lines.push(''); lines.push(csvCell(t.title)); } t.rows.forEach((r) => lines.push(r.map(csvCell).join(','))); });
  download(`${safeName(title)}-${stamp()}.csv`, 'text/csv;charset=utf-8', '﻿' + lines.join('\r\n')); // BOM ليفتح Excel العربية صحيحة
}
export function exportExcel(title: string, company: string) {
  const tables = collectTables(); if (!tables.length) return toast('لا توجد جداول في هذه الشاشة للتصدير.', 'warn');
  const body = tables.map((t) => `<h3>${esc(t.title)}</h3><table border="1" dir="rtl">${t.rows.map((r, ri) => `<tr>${r.map((c) => (ri === 0 ? `<th style="background:#e2e8f0">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</table><br/>`).join('');
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"/><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${esc(safeName(title).slice(0, 30))}</x:Name><x:WorksheetOptions><x:DisplayRightToLeft/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body dir="rtl"><h2>${esc(company)} — ${esc(title)}</h2><p>${stamp()}</p>${body}</body></html>`;
  download(`${safeName(title)}-${stamp()}.xls`, 'application/vnd.ms-excel;charset=utf-8', '﻿' + html);
}
export function printPage() { window.print(); } // «حفظ كـ PDF» من نافذة الطباعة

export default function PageTools({ title, company }: { title: string; company: string }) {
  const b = 'rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100';
  return (
    <div className="ct-no-print flex items-center gap-1.5" role="group" aria-label="أدوات التقرير">
      <button className={b} title="تصدير الجداول CSV" onClick={() => exportCsv(title)}>⬇ CSV</button>
      <button className={b} title="تصدير الجداول إلى Excel" onClick={() => exportExcel(title, company)}>⬇ Excel</button>
      <button className={b} title="طباعة أو حفظ PDF" onClick={printPage}>🖨 طباعة / PDF</button>
    </div>
  );
}

/** ترويسة الطباعة فقط (تظهر في الطباعة وتختفي على الشاشة). */
export function PrintHeader({ title, company }: { title: string; company: string }) {
  return (
    <div className="ct-print-only mb-3 border-b border-slate-400 pb-2">
      <div className="text-lg font-extrabold">{company}</div>
      <div className="flex justify-between text-sm"><span>{title}</span><span>{new Date().toLocaleString('ar-EG')}</span></div>
    </div>
  );
}
