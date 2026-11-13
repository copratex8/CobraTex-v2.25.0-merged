/**
 * إضافة نموذجية 1: حاسبة سريعة (ضريبة القيمة المضافة + الخصم) — إضافة واجهة بحتة بلا خادم.
 * تستخدم أصناف مجموعة الهدى (card, fg, fc, btn, sum-bar) المتاحة عالميًا.
 */
const plugin = {
  id: 'quick-calc',
  name: 'حاسبة الضريبة والخصم',
  version: '1.0.0',
  description: 'احسب صافي السعر والضريبة بسرعة دون مغادرة النظام',
  section: { group: 'extensions', groupLabel: 'الإضافات', icon: '🧮' },

  mount(container, ctx) {
    const fmt = (n) => n.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    container.innerHTML = `
      <div class="card">
        <div class="card-hdr"><span class="card-title">الحساب</span><span class="card-badge">${ctx.brand.appName}</span></div>
        <div class="fg3">
          <div class="fg"><label>المبلغ قبل الضريبة</label><input class="fc" id="qc-amount" type="number" min="0" step="0.01" value="1000"></div>
          <div class="fg"><label>الخصم %</label><input class="fc" id="qc-disc" type="number" min="0" max="100" step="0.01" value="0"></div>
          <div class="fg"><label>الضريبة %</label><input class="fc" id="qc-vat" type="number" min="0" max="100" step="0.01" value="14"></div>
        </div>
        <div class="sum-bar" id="qc-out"></div>
      </div>`;

    const $ = (id) => container.querySelector(id);
    const render = () => {
      const amount = Number($('#qc-amount').value) || 0;
      const disc = Math.min(Math.max(Number($('#qc-disc').value) || 0, 0), 100);
      const vat = Math.max(Number($('#qc-vat').value) || 0, 0);
      const afterDisc = amount * (1 - disc / 100);
      const tax = afterDisc * (vat / 100);
      $('#qc-out').innerHTML = [
        ['قيمة الخصم', amount - afterDisc],
        ['الصافي بعد الخصم', afterDisc],
        ['قيمة الضريبة', tax],
        ['الإجمالي', afterDisc + tax],
      ].map(([l, v]) => `<div class="sum-item"><div class="sum-lbl">${l}</div><div class="sum-val">${fmt(v)}</div></div>`).join('');
    };
    container.addEventListener('input', render);
    render();
    return () => container.removeEventListener('input', render);
  },
};

if (window.CobraTex) window.CobraTex.registerPlugin(plugin);
export default plugin;
