/**
 * إضافة نموذجية 2: نبض النظام — تُظهر كيف تستدعي الإضافة الخادم بأمان عبر ctx.api
 * (نفس توكن المستخدم وتجديد الجلسة التلقائي، فلا حاجة لإدارة مصادقة داخل الإضافة).
 */
const plugin = {
  id: 'system-pulse',
  name: 'نبض النظام',
  version: '1.0.0',
  description: 'حالة الخادم وقاعدة البيانات وزمن الاستجابة',
  section: { group: 'extensions', groupLabel: 'الإضافات', icon: '💓' },

  mount(container, ctx) {
    container.innerHTML = `
      <div class="kpi-grid cols-3">
        <div class="kpi good"><span class="kpi-icon">🌐</span><p class="kpi-lbl">حالة الخادم</p><p class="kpi-val" id="sp-status">…</p></div>
        <div class="kpi info"><span class="kpi-icon">⚡</span><p class="kpi-lbl">زمن الاستجابة</p><p class="kpi-val" id="sp-latency">…</p></div>
        <div class="kpi"><span class="kpi-icon">🏷️</span><p class="kpi-lbl">إصدار الخادم</p><p class="kpi-val" id="sp-version">…</p></div>
      </div>
      <button class="btn btn-gold btn-sm" id="sp-refresh">إعادة الفحص</button>`;

    const set = (id, v) => { const el = container.querySelector(id); if (el) el.textContent = v; };
    let alive = true;
    const check = async () => {
      set('#sp-status', '…');
      const t0 = performance.now();
      try {
        const res = await ctx.api.get('/system/version');
        if (!alive) return;
        set('#sp-status', 'يعمل ✔');
        set('#sp-latency', Math.round(performance.now() - t0) + ' ms');
        set('#sp-version', res.data.version);
      } catch {
        if (!alive) return;
        set('#sp-status', 'متوقف ✖');
        set('#sp-latency', '—');
        ctx.toast('تعذّر الوصول إلى الخادم', 'error');
      }
    };
    container.querySelector('#sp-refresh').addEventListener('click', check);
    check();
    return () => { alive = false; };
  },
};

if (window.CobraTex) window.CobraTex.registerPlugin(plugin);
export default plugin;
