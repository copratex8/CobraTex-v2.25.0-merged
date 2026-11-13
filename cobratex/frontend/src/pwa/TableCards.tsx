import { useEffect } from 'react';

/**
 * يحوّل كل الجداول العريضة إلى «بطاقات» على الجوال دون لمس 59 جدولًا يدويًا:
 *  - يقرأ عناوين <th> ويضعها في data-label لكل <td> (يعرضها CSS قبل القيمة).
 *  - لا يُفعَّل إلا إن كان الجدول بسيطًا (صف عناوين واحد، عدد الخلايا = عدد العناوين، بلا colspan/rowspan).
 *  - للاستثناء: أضف class="ct-keep-table" للجدول. الطباعة والشاشات العريضة لا تتأثر (القواعد داخل @media).
 * CSS الخاص به يضيفه apply-v2.sh إلى index.css.
 */
function enhance(table: HTMLTableElement) {
  if (table.classList.contains('ct-keep-table')) return;
  const headRows = table.tHead?.rows;
  const body = table.tBodies[0];
  if (!headRows || headRows.length !== 1 || !body || body.rows.length === 0) return;
  const labels = Array.from(headRows[0].cells).map((c) => (c.textContent ?? '').trim());
  if (labels.length < 3) return;
  const span = (c: HTMLTableCellElement) => c.colSpan > 1 || c.rowSpan > 1;
  if (Array.from(headRows[0].cells).some(span)) return;

  for (const row of Array.from(body.rows)) {
    if (row.cells.length !== labels.length || Array.from(row.cells).some(span)) {
      table.classList.remove('ct-cards');
      return;
    }
  }
  for (const row of Array.from(body.rows)) {
    Array.from(row.cells).forEach((cell, i) => {
      if (cell.getAttribute('data-label') !== labels[i]) cell.setAttribute('data-label', labels[i]);
    });
  }
  table.classList.add('ct-cards');
}

export default function TableCards() {
  useEffect(() => {
    const root = document.querySelector('.ct-main');
    if (!root) return;
    let frame = 0;
    const run = () => {
      frame = 0;
      root.querySelectorAll('table').forEach((t) => enhance(t as HTMLTableElement));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(run);
    };
    run();
    // childList فقط (لا attributes) كي لا تُطلق تعديلاتنا نفسها حلقة لا نهائية.
    const mo = new MutationObserver(schedule);
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}
