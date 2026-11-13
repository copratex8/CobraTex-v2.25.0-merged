/* لوحة المطور — كوبرا تكس (تطبيق ثابت بلا بناء، جافاسكربت خام).
   تتحكم عن بُعد في: تشغيل/إيقاف المنصة كلها أو عميل بعينه، وإشعارات شاشة تسجيل الدخول. */
(() => {
  'use strict';
  const $app = document.getElementById('app');
  const SKEY = 'cx_dev_token', BKEY = 'cx_dev_api', LKEY = 'cx_dev_servers';
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k) || localStorage.getItem(k); } catch { return null; } },
  };
  // كل خادم (عميل) له جلسته الخاصة: التوكن يُحفَظ لكل عنوان على حدة في sessionStorage فقط (يُمحى بإغلاق التبويب).
  const tokenKey = () => `${SKEY}:${(store.get(BKEY) || window.COBRATEX_PANEL?.apiBase || '').replace(/\/+$/, '')}`;
  const state = { token: (() => { try { return sessionStorage.getItem(tokenKey()); } catch { return null; } })(), data: null, busy: false };

  /* سجل الخوادم: لكل عميل نشرٌ مستقل (قاعدة + باك إند). يُحفَظ الاسم والعنوان فقط (لا أسرار) في متصفحك. */
  const servers = {
    list() { try { const v = JSON.parse(localStorage.getItem(LKEY) || '[]'); return Array.isArray(v) ? v.filter((s) => s && typeof s.name === 'string' && typeof s.url === 'string') : []; } catch { return []; } },
    save(l) { try { localStorage.setItem(LKEY, JSON.stringify(l)); } catch { /* ignore */ } },
    normalize(u) { const x = new URL(u.trim()); if (x.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(x.hostname)) throw new Error('العنوان يجب أن يكون https'); return x.origin; },
  };
  function selectServer(url) {
    try { localStorage.setItem(BKEY, url); } catch { /* ignore */ }
    try { state.token = sessionStorage.getItem(tokenKey()); } catch { state.token = null; }
    state.data = null; state.activity = null;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const apiBase = () => (store.get(BKEY) || window.COBRATEX_PANEL?.apiBase || '').replace(/\/+$/, '');
  const fmtDate = (v) => (v ? new Date(v).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const SEV = { info: 'معلومة', success: 'نجاح', warning: 'تنبيه', critical: 'عاجل' };

  function toast(msg, ok = true) {
    const el = document.createElement('div');
    el.className = `toast ${ok ? 'ok' : 'bad'}`; el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${apiBase()}/api${path}`, {
      method, cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token) { logout(); throw new Error('انتهت الجلسة — سجّل الدخول مجددًا'); }
    if (!res.ok) throw new Error(data.error || `خطأ ${res.status}`);
    return data;
  }

  function logout() {
    state.token = null; state.data = null;
    try { sessionStorage.removeItem(tokenKey()); } catch { /* ignore */ }
    renderLogin();
  }

  /* ───────── تأكيد (بديل confirm) ───────── */
  function confirmBox({ title, text, okLabel = 'تأكيد', danger = false, withMessage = false, messageDefault = '' }) {
    return new Promise((resolve) => {
      const bg = document.createElement('div');
      bg.className = 'modal-bg';
      bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><p>${esc(text)}</p>
        ${withMessage ? `<label>رسالة تظهر للمستخدمين</label><textarea class="fc" id="cb-msg" maxlength="500" placeholder="مثال: الخدمة متوقفة للصيانة حتى الساعة 10 مساءً">${esc(messageDefault)}</textarea>` : ''}
        <div class="actions"><button class="btn btn-outline" id="cb-no">إلغاء</button><button class="btn ${danger ? 'btn-red' : 'btn-green'}" id="cb-ok">${esc(okLabel)}</button></div></div>`;
      document.body.appendChild(bg);
      const done = (v) => { bg.remove(); resolve(v); };
      bg.querySelector('#cb-no').onclick = () => done(null);
      bg.querySelector('#cb-ok').onclick = () => done({ message: bg.querySelector('#cb-msg')?.value.trim() ?? '' });
      bg.addEventListener('click', (e) => { if (e.target === bg) done(null); });
    });
  }

  /* ───────── شاشة الدخول ───────── */
  function renderLogin(error = '') {
    $app.innerHTML = `<div class="login"><form class="login-card" id="lf">
      <img src="assets/logo-full.jpg" alt="كوبرا تكس">
      <div class="tag"><span class="badge-dev">لوحة المطور — التحكم عن بُعد</span></div>
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      <label>العميل / الخادم</label>
      <select class="fc" id="srv">${servers.list().map((s) => `<option value="${esc(s.url)}" ${s.url === apiBase() ? 'selected' : ''}>${esc(s.name)} — ${esc(s.url.replace(/^https?:\/\//, ''))}</option>`).join('')}${servers.list().some((s) => s.url === apiBase()) ? '' : `<option value="${esc(apiBase())}" selected>${esc(apiBase() || 'غير محدد')}</option>`}</select>
      <label>كلمة مرور المطوّر</label>
      <input class="fc" type="password" id="secret" autocomplete="current-password" dir="ltr" required autofocus>
      <label>رمز التحقق (من تطبيق المصادقة — إن كان مفعّلًا)</label>
      <input class="fc" id="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr" placeholder="123456">
      <button class="btn btn-primary btn-block" id="go">دخول</button>
      <div style="text-align:center;margin-top:12px"><button type="button" class="link" id="chg">إدارة خوادم العملاء</button></div>
    </form></div>`;
    document.getElementById('chg').onclick = () => serversModal(() => renderLogin());
    document.getElementById('srv').onchange = (e) => { selectServer(e.target.value); if (state.token) load(); else renderLogin(); };
    document.getElementById('lf').onsubmit = async (e) => {
      e.preventDefault();
      const btn = document.getElementById('go'); btn.disabled = true; btn.textContent = 'جارٍ الدخول…';
      try {
        const r = await api('/developer/login', { method: 'POST', body: { secret: document.getElementById('secret').value, code: document.getElementById('totp').value.trim() } });
        state.token = r.token;
        try { sessionStorage.setItem(tokenKey(), r.token); } catch { /* ignore */ }
        await load();
      } catch (err) {
        renderLogin(err.message === 'Failed to fetch' ? 'تعذّر الوصول للخادم — تحقق من العنوان أو أن الخادم يعمل (قد يحتاج لحظات ليستيقظ).' : err.message);
      }
    };
  }

  /* ───────── اللوحة ───────── */
  async function load() {
    try {
      state.data = await api('/developer/overview');
      try { state.activity = await api('/developer/activity'); } catch { state.activity = null; }
      try { state.licenses = await api('/developer/licenses'); } catch { state.licenses = null; }
      renderDash();
    } catch (err) {
      if (state.token) { toast(err.message, false); if (!state.data) renderLogin(err.message); }
    }
  }

  function annHtml(a) { return `<div class="ann a-${esc(a.severity)}"><b>${esc(a.title)}</b>${a.body ? esc(a.body) : ''}</div>`; }

  function renderDash() {
    const d = state.data; const on = d.global.status === 'active';
    const activeNow = d.announcements.filter((a) => a.is_active && (!a.starts_at || new Date(a.starts_at) <= new Date()) && (!a.ends_at || new Date(a.ends_at) > new Date()));
    $app.innerHTML = `
      <header class="top"><div class="brand"><img src="assets/emblem.png" alt=""><div><b>لوحة المطور — كوبرا تكس</b><small>التحكم عن بُعد في التشغيل والإشعارات</small></div></div>
        <div class="right"><button class="btn btn-outline btn-sm" id="servers" style="color:var(--gold2)">🖧 الخوادم</button><button class="btn btn-outline btn-sm" id="refresh" style="color:var(--gold2)">↻ تحديث</button><button class="btn btn-outline btn-sm" id="out" style="color:var(--gold2)">خروج</button></div></header>
      <main>
        <section class="master ${on ? 'on' : 'off'}">
          <div><h1><span class="pulse"></span>${on ? 'المنصة تعمل لجميع العملاء' : 'المنصة موقوفة لجميع العملاء'}</h1>
            <p>${on ? 'كل العملاء يستطيعون الدخول والعمل بشكل طبيعي.' : `الرسالة المعروضة: ${esc(d.global.message || '(الرسالة الافتراضية)')}`}</p></div>
          <button class="btn ${on ? 'btn-red' : 'btn-gold'}" id="master">${on ? '⛔ إيقاف المنصة بالكامل' : '▶ إعادة تشغيل المنصة'}</button>
        </section>

        <div class="grid g2">
          <section class="card"><h2>📢 إشعار جديد لشاشة الدخول</h2>
            <form id="af">
              <label>العنوان *</label><input class="fc" id="a-title" maxlength="200" required placeholder="مثال: صيانة مجدولة الليلة">
              <label>النص</label><textarea class="fc" id="a-body" maxlength="2000" placeholder="تفاصيل الإشعار (اختياري)"></textarea>
              <div class="row2"><div><label>الدرجة</label><select class="fc" id="a-sev"><option value="info">معلومة</option><option value="success">نجاح</option><option value="warning">تنبيه</option><option value="critical">عاجل</option></select></div>
                <div><label>الموجَّه إلى</label><select class="fc" id="a-ten"><option value="">كل العملاء</option>${d.tenants.map((t) => `<option value="${esc(t.id)}">${esc(t.company_name || t.name)}</option>`).join('')}</select></div></div>
              <div class="row2"><div><label>يبدأ (اختياري)</label><input class="fc" type="datetime-local" id="a-start"></div><div><label>ينتهي (اختياري)</label><input class="fc" type="datetime-local" id="a-end"></div></div>
              <button class="btn btn-gold btn-block">نشر الإشعار</button>
            </form></section>
          <section class="card"><h2>👁 معاينة شاشة الدخول (الآن)</h2>
            <div class="preview"><div class="mini">${activeNow.length ? activeNow.map(annHtml).join('') : '<div class="empty">لا إشعارات فعّالة حاليًا</div>'}</div></div></section>
        </div>

        ${remoteCardsHtml(d)}

        <section class="card"><h2>🏢 العملاء <span class="pill p-info">${d.tenants.length}</span></h2>
          <div class="tbl"><table><thead><tr><th>العميل</th><th>الحالة</th><th>الترخيص</th><th>الرسالة</th><th>أُنشئ</th><th></th></tr></thead><tbody>
          ${d.tenants.length ? d.tenants.map((t) => `<tr><td><b>${esc(t.company_name || t.name)}</b><br><code>${esc(t.id)}</code></td>
            <td><span class="pill ${t.status === 'active' ? 'p-on' : 'p-off'}">${t.status === 'active' ? 'يعمل' : 'موقوف'}</span></td>
            <td>${licCell(t)}</td><td>${esc(t.message) || '—'}</td><td>${fmtDate(t.created_at)}</td>
            <td><div class="actions"><button class="btn btn-sm ${t.status === 'active' ? 'btn-red' : 'btn-green'}" data-tenant="${esc(t.id)}" data-to="${t.status === 'active' ? 'suspended' : 'active'}" data-name="${esc(t.company_name || t.name)}">${t.status === 'active' ? 'إيقاف' : 'تشغيل'}</button><button class="btn btn-sm btn-outline" data-copy="${esc(t.id)}">نسخ المعرّف</button></div></td></tr>`).join('')
            : '<tr><td colspan="6" class="empty">لا يوجد عملاء بعد</td></tr>'}
          </tbody></table></div></section>

        <section class="card"><h2>📋 كل الإشعارات <span class="pill p-info">${d.announcements.length}</span></h2>
          <div class="tbl"><table><thead><tr><th>العنوان</th><th>الدرجة</th><th>الموجَّه إلى</th><th>الفترة</th><th>الحالة</th><th></th></tr></thead><tbody>
          ${d.announcements.length ? d.announcements.map((a) => `<tr><td><b>${esc(a.title)}</b>${a.body ? `<br><small>${esc(a.body.slice(0, 90))}</small>` : ''}</td>
            <td><span class="pill p-${esc(a.severity)}">${SEV[a.severity] || esc(a.severity)}</span></td><td>${esc(a.tenant_name || 'الكل')}</td>
            <td><small>${fmtDate(a.starts_at)} ← ${fmtDate(a.ends_at)}</small></td>
            <td><span class="pill ${a.is_active ? 'p-on' : 'p-off'}">${a.is_active ? 'فعّال' : 'مخفي'}</span></td>
            <td><div class="actions"><button class="btn btn-sm btn-outline" data-ann-toggle="${esc(a.id)}" data-active="${a.is_active}">${a.is_active ? 'إخفاء' : 'إظهار'}</button><button class="btn btn-sm btn-red" data-ann-del="${esc(a.id)}">حذف</button></div></td></tr>`).join('')
            : '<tr><td colspan="6" class="empty">لا توجد إشعارات</td></tr>'}
          </tbody></table></div></section>

        ${clientsHtml()}
        ${licensesHtml()}
        ${activityHtml()}

        <section class="card"><h2>🧾 سجل أوامر التحكم</h2>
          <div class="tbl"><table><thead><tr><th>الوقت</th><th>الأمر</th><th>التفاصيل</th></tr></thead><tbody>
          ${d.audit.length ? d.audit.map((x) => `<tr><td>${fmtDate(x.created_at)}</td><td><code>${esc(x.action)}</code></td><td><code>${esc(JSON.stringify(x.detail))}</code></td></tr>`).join('') : '<tr><td colspan="3" class="empty">لا أوامر بعد</td></tr>'}
          </tbody></table></div></section>
        <div class="foot">تم التطوير بواسطة شركة حي تك - جميع الحقوق محفوظة · <span dir="ltr">01014868778</span></div>
      </main>`;
    bind();
  }


  /* ───────── العملاء: إنشاء + هوية + حسابات ───────── */
  const FKEY = 'cx_dev_front';
  const frontUrl = () => (store.get(FKEY) || '').replace(/\/+$/, '');
  const clientLink = (slug, tid) => `${frontUrl() || 'https://<رابط-الواجهة>'}/${slug ? '?c=' + slug : '?t=' + tid}`;
  function clientsHtml() {
    const items = (state.licenses && state.licenses.items) || [];
    return `<section class="card"><h2>🏷️ العملاء: إنشاء وهوية وحسابات</h2>
      <p style="margin:0 0 10px;color:var(--muted,#667)">العميل يأخذ <b>رابطًا فقط</b> (أو نطاقه الخاص) ويرى هويته هو. الكود والخادم عندك. <small>اسم/أيقونة التطبيق عند «تثبيته» تبقى من نشر الواجهة؛ أما الاسم والشعار والألوان داخل البرنامج فمن هنا.</small></p>
      <label>رابط الواجهة المنشورة (يُحفظ في متصفحك لتوليد روابط العملاء)<input class="fc" id="frontUrl" dir="ltr" placeholder="https://app.example.com" value="${esc(frontUrl())}"></label>
      <details style="margin:12px 0"><summary style="cursor:pointer;font-weight:700">➕ إنشاء عميل جديد</summary>
        <div id="newClient" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-top:8px">
          <label>اسم العميل *<input class="fc nc-tenant"></label><label>الاسم القانوني للشركة *<input class="fc nc-legal"></label>
          <label>اسم العرض<input class="fc nc-display"></label><label>اسم المالك<input class="fc nc-owner" placeholder="مدير النظام"></label>
          <label>بريد المالك *<input class="fc nc-email" dir="ltr" type="email"></label><label>كلمة المرور (فارغ = تُولَّد)<input class="fc nc-pass" dir="ltr"></label>
          <label>الرمز القصير للرابط<input class="fc nc-slug" dir="ltr" placeholder="acme"></label>
          <label>الترخيص<select class="fc nc-plan"><option value="">بلا ترخيص (بلا قيود)</option><option value="trial">تجربة 14 يومًا</option><option value="monthly">شهري</option><option value="annual">سنوي</option><option value="perpetual">دائم</option></select></label></div>
        <button class="btn btn-sm btn-gold" id="ncCreate" style="margin-top:8px">إنشاء العميل</button><div id="ncResult" style="margin-top:8px"></div></details>
      ${items.map((it) => `<details class="cl-co" data-t="${esc(it.tenantId)}" style="border:1px solid #ddd;border-radius:10px;padding:10px;margin-bottom:10px"><summary style="cursor:pointer"><b>${esc(it.companyName || it.name)}</b></summary><div class="cl-body" style="margin-top:8px"><button class="btn btn-sm btn-outline cl-load">تحميل الهوية والمستخدمين</button></div></details>`).join('')}
    </section>`;
  }
  const BR = [['appName', 'اسم التطبيق (عربي)'], ['appNameEn', 'اسم التطبيق (إنجليزي)'], ['tagline', 'الشعار النصي'], ['companyName', 'اسم الشركة'], ['supportPhone', 'هاتف الدعم'], ['supportEmail', 'بريد الدعم'], ['website', 'الموقع'], ['logoUrl', 'رابط الشعار الدائري (https أو /مسار)'], ['logoFullUrl', 'رابط الشعار الكامل'], ['faviconUrl', 'رابط الأيقونة']];
  const TH = [['navy', 'اللون الأساسي'], ['navy2', 'الأساسي الثاني'], ['gold', 'لون التمييز'], ['gold2', 'التمييز الثاني']];
  async function loadClient(box) {
    const t = box.dataset.t; const body = box.querySelector('.cl-body');
    const [b, users] = await Promise.all([api(`/developer/tenants/${t}/branding`), api(`/developer/tenants/${t}/users`)]);
    const br = b.brand || {}; const th = br.theme || {};
    body.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">
      <label>الرمز القصير<input class="fc b-slug" dir="ltr" value="${esc(b.slug || '')}" placeholder="acme"></label>
      ${BR.map(([k, n]) => `<label>${n}<input class="fc b-${k}" ${/Url|website|Email/.test(k) ? 'dir="ltr"' : ''} value="${esc(br[k] || '')}"></label>`).join('')}
      ${TH.map(([k, n]) => `<label>${n}<input class="fc b-th-${k}" type="color" value="${esc(th[k] || '#000000')}" data-set="${th[k] ? 1 : 0}"></label>`).join('')}</div>
      <label style="display:block;margin-top:8px">نطاقات العميل الخاصة (سطر لكل نطاق، بعد ضبط CNAME على الاستضافة)<textarea class="fc b-domains" rows="2" dir="ltr">${esc((b.domains || []).join('\n'))}</textarea></label>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-sm btn-gold b-save">حفظ الهوية</button><button class="btn btn-sm btn-outline b-copy">نسخ رابط العميل</button></div>
      <h3 style="margin:14px 0 6px">المستخدمون</h3>
      ${users.length ? `<div class="tbl"><table><thead><tr><th>الاسم</th><th>البريد</th><th>آخر دخول</th><th>الحالة</th><th></th></tr></thead><tbody>${users.map((u) => `<tr><td>${esc(u.full_name)}</td><td dir="ltr">${esc(u.email)}</td><td>${u.last_login_at ? esc(new Date(u.last_login_at).toLocaleString('ar-EG')) : '—'}</td><td>${u.is_active ? '<span class="pill p-success">فعّال</span>' : '<span class="pill p-critical">معطّل</span>'}</td>
        <td><button class="btn btn-sm btn-outline u-reset" data-u="${esc(u.id)}">إعادة ضبط كلمة المرور</button> <button class="btn btn-sm btn-outline u-act" data-u="${esc(u.id)}" data-a="${u.is_active ? 0 : 1}">${u.is_active ? 'تعطيل' : 'تفعيل'}</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">لا مستخدمون</div>'}
      <div class="u-out" style="margin-top:8px"></div>`;
    const g = (c) => body.querySelector(c).value.trim();
    body.querySelector('.b-save').onclick = () => {
      const brand = {}; BR.forEach(([k]) => { const v = g('.b-' + k); if (v) brand[k] = v; });
      const theme = {}; TH.forEach(([k]) => { const el = body.querySelector('.b-th-' + k); if (el.dataset.set === '1' || el.value !== '#000000') theme[k] = el.value; }); if (Object.keys(theme).length) brand.theme = theme;
      run(() => api(`/developer/tenants/${t}/branding`, { method: 'PUT', body: { slug: g('.b-slug') || null, brand, domains: g('.b-domains').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean) } }), 'تم حفظ الهوية');
    };
    body.querySelector('.b-copy').onclick = async () => { const l = clientLink(g('.b-slug'), t); try { await navigator.clipboard.writeText(l); toast('نُسخ: ' + l, true); } catch { prompt('رابط العميل:', l); } };
    body.querySelectorAll('.u-reset').forEach((b) => (b.onclick = async () => {
      if (!(await confirmBox({ title: 'إعادة ضبط كلمة المرور؟', text: 'تُولَّد كلمة جديدة وتُنهى كل جلسات المستخدم فورًا. تُعرض مرة واحدة فقط.', okLabel: 'إعادة ضبط', danger: true }))) return;
      try { const r = await api(`/developer/tenants/${t}/users/${b.dataset.u}/reset-password`, { method: 'POST', body: {} }); body.querySelector('.u-out').innerHTML = `<div class="pill p-warning" style="padding:10px;display:block">كلمة المرور الجديدة (انسخها الآن، لن تُعرض ثانية): <b dir="ltr" style="user-select:all">${esc(r.password)}</b></div>`; } catch (e) { toast(e.message, false); }
    }));
    body.querySelectorAll('.u-act').forEach((b) => (b.onclick = () => run(() => api(`/developer/tenants/${t}/users/${b.dataset.u}`, { method: 'PATCH', body: { active: b.dataset.a === '1' } }), 'تم التحديث')));
  }
  function bindClients() {
    const fu = document.getElementById('frontUrl'); if (fu) fu.onchange = () => { try { localStorage.setItem(FKEY, fu.value.trim()); } catch { /* ignore */ } };
    document.querySelectorAll('.cl-co').forEach((box) => { const b = box.querySelector('.cl-load'); if (b) b.onclick = async () => { try { await loadClient(box); } catch (e) { toast(e.message, false); } }; });
    const cr = document.getElementById('ncCreate'); if (!cr) return;
    cr.onclick = async () => {
      const root = document.getElementById('newClient'); const v = (c) => root.querySelector(c).value.trim();
      const body = { tenantName: v('.nc-tenant'), companyLegalName: v('.nc-legal'), companyDisplayName: v('.nc-display') || undefined, ownerFullName: v('.nc-owner') || undefined, ownerEmail: v('.nc-email'), ownerPassword: v('.nc-pass') || undefined, slug: v('.nc-slug') || undefined };
      if (v('.nc-plan')) body.license = { planType: v('.nc-plan') };
      cr.disabled = true;
      try {
        const r = await api('/developer/tenants', { method: 'POST', body });
        document.getElementById('ncResult').innerHTML = `<div class="pill p-success" style="display:block;padding:10px;line-height:2">✔ تم إنشاء العميل.<br>رابطه: <b dir="ltr" style="user-select:all">${esc(clientLink(body.slug, r.tenantId))}</b><br>البريد: <b dir="ltr">${esc(r.ownerEmail)}</b> — كلمة المرور: <b dir="ltr" style="user-select:all">${esc(r.ownerPassword)}</b> <small>(تُعرض مرة واحدة)</small>${(r.warnings || []).map((w) => `<br>⚠ ${esc(w)}`).join('')}</div>`;
      } catch (e) { toast(e.message, false); } finally { cr.disabled = false; }
    };
  }

  /* ───────── التراخيص ───────── */
  const PLAN_AR = { trial: 'تجربة', monthly: 'شهري', annual: 'سنوي', perpetual: 'دائم', custom: 'مخصص' };
  const STATE_AR = { none: ['بلا ترخيص', 'p-info'], not_started: ['لم يبدأ', 'p-warning'], active: ['فعّال', 'p-success'], grace: ['مهلة سماح', 'p-warning'], expired: ['منتهٍ', 'p-critical'] };
  const dayVal = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
  function licensesHtml() {
    const L = state.licenses; if (!L) return '';
    return `<section class="card"><h2>🔑 التراخيص <span class="pill p-info">${L.items.length}</span></h2>
      <p style="margin:0 0 10px;color:var(--muted,#667)">لكل عميل: نوع الترخيص (تجربة/شهري/سنوي/دائم/مخصص)، تاريخ الانتهاء، مهلة السماح، ما يحدث بعد الانتهاء (قراءة فقط أو إيقاف)، والربط بنطاق أو جهاز، وحدود المستخدمين والفروع. يُنفَّذ من الخادم.
      ${L.licenseRequired ? '' : '<br><small>عميل بلا ترخيص = بلا قيود (للعملاء القدامى). اضبط <code>LICENSE_REQUIRED=1</code> على الخادم لرفض من لا ترخيص له.</small>'}
      <br><small>تنبيه: من يملك الكود ويستضيفه بنفسه قادر على إزالة الفحص — الحماية الأساسية هي العقد؛ هذا طبقة تشغيلية.</small></p>
      ${L.items.map((it) => { const l = it.license || {}; const st = STATE_AR[it.state] || STATE_AR.none;
        return `<div class="lic-co" data-t="${esc(it.tenantId)}" style="border:1px solid #ddd;border-radius:10px;padding:12px;margin-bottom:12px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px"><b>${esc(it.companyName || it.name)}</b>
          <span class="pill ${st[1]}">${st[0]}${it.daysLeft != null && it.state === 'active' ? ` — ${it.daysLeft} يوم` : ''}</span>
          <small>مستخدمون ${it.usage.users}${l.maxUsers ? '/' + l.maxUsers : ''} • فروع ${it.usage.branches}${l.maxBranches ? '/' + l.maxBranches : ''} • أجهزة ${it.usage.devices}${l.maxDevices ? '/' + l.maxDevices : ''}</small></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><small>تعبئة سريعة:</small>
          ${['trial', 'monthly', 'annual', 'perpetual'].map((p) => `<button type="button" class="btn btn-sm btn-outline lic-preset" data-plan="${p}">${PLAN_AR[p]}</button>`).join('')}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">
          <label>النوع<select class="fc lic-plan">${L.plans.map((p) => `<option value="${p}" ${l.planType === p ? 'selected' : ''}>${PLAN_AR[p]}</option>`).join('')}</select></label>
          <label>يبدأ<input class="fc lic-start" type="date" value="${dayVal(l.startsAt)}"></label>
          <label>ينتهي (فارغ = تلقائي حسب النوع)<input class="fc lic-end" type="date" value="${dayVal(l.expiresAt)}"></label>
          <label>مهلة السماح (أيام)<input class="fc lic-grace" type="number" min="0" max="365" value="${l.graceDays ?? 7}"></label>
          <label>بعد انتهاء المهلة<select class="fc lic-mode"><option value="readonly" ${l.expiredMode !== 'block' ? 'selected' : ''}>قراءة فقط</option><option value="block" ${l.expiredMode === 'block' ? 'selected' : ''}>إيقاف كامل</option></select></label>
          <label>الربط<select class="fc lic-bind">${[['none', 'بلا ربط'], ['domain', 'بنطاق'], ['device', 'بجهاز'], ['domain_device', 'نطاق + جهاز']].map(([v, n]) => `<option value="${v}" ${(l.bindingMode || 'none') === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label>أقصى أجهزة<input class="fc lic-dev" type="number" min="1" value="${l.maxDevices ?? ''}" placeholder="3 عند الربط بجهاز"></label>
          <label>أقصى مستخدمين<input class="fc lic-users" type="number" min="1" value="${l.maxUsers ?? ''}" placeholder="بلا حد"></label>
          <label>أقصى فروع<input class="fc lic-br" type="number" min="1" value="${l.maxBranches ?? ''}" placeholder="بلا حد"></label></div>
        <label style="display:block;margin-top:8px">النطاقات المسموحة (واحد في كل سطر، ويقبل *.example.com)<textarea class="fc lic-dom" rows="2">${esc((l.allowedDomains || []).join('\n'))}</textarea></label>
        <label style="display:block;margin-top:8px">ملاحظات داخلية<input class="fc lic-notes" maxlength="1000" value="${esc(l.notes || '')}"></label>
        <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm btn-gold lic-save">حفظ الترخيص</button>
          ${it.license && l.planType !== 'perpetual' ? `<button class="btn btn-sm btn-outline lic-ext" data-u="months" data-n="1">+ شهر</button><button class="btn btn-sm btn-outline lic-ext" data-u="months" data-n="3">+ 3 أشهر</button><button class="btn btn-sm btn-outline lic-ext" data-u="years" data-n="1">+ سنة</button>` : ''}
          ${it.license ? `<button class="btn btn-sm btn-outline lic-devs">الأجهزة</button><button class="btn btn-sm btn-red lic-del">إلغاء الترخيص</button>` : ''}</div>
        <div class="lic-devbox" style="margin-top:8px"></div></div>`; }).join('')}
    </section>`;
  }
  function renderDevices(box, tenant, rows) {
    box.innerHTML = rows.length ? `<div class="tbl"><table><thead><tr><th>الجهاز</th><th>الاسم</th><th>أول ظهور</th><th>آخر ظهور</th><th>الحالة</th><th></th></tr></thead><tbody>${rows.map((d) => `<tr>
      <td><code>${esc(d.device_id.slice(0, 8))}…</code><br><small>${esc((d.user_agent || '').slice(0, 50))}</small></td>
      <td><input class="fc dev-label" data-id="${esc(d.device_id)}" value="${esc(d.label || '')}" placeholder="مثال: مكتب المحاسبة" style="min-width:140px"></td>
      <td>${esc(new Date(d.first_seen).toLocaleDateString('ar-EG'))}</td><td>${esc(new Date(d.last_seen).toLocaleString('ar-EG'))}</td>
      <td>${d.revoked ? '<span class="pill p-critical">ملغى</span>' : '<span class="pill p-success">فعّال</span>'}</td>
      <td><button class="btn btn-sm btn-outline dev-toggle" data-id="${esc(d.device_id)}" data-rev="${d.revoked ? 0 : 1}">${d.revoked ? 'تفعيل' : 'إلغاء'}</button> <button class="btn btn-sm btn-red dev-del" data-id="${esc(d.device_id)}">حذف</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">لا أجهزة مسجَّلة بعد</div>';
    box.querySelectorAll('.dev-label').forEach((i) => (i.onchange = () => run(() => api(`/developer/tenants/${tenant}/devices/${i.dataset.id}`, { method: 'PATCH', body: { label: i.value } }), 'تم حفظ الاسم')));
    box.querySelectorAll('.dev-toggle').forEach((b) => (b.onclick = () => run(() => api(`/developer/tenants/${tenant}/devices/${b.dataset.id}`, { method: 'PATCH', body: { revoked: b.dataset.rev === '1' } }), 'تم التحديث')));
    box.querySelectorAll('.dev-del').forEach((b) => (b.onclick = async () => { if (await confirmBox({ title: 'حذف الجهاز؟', text: 'يتحرر مقعده ويمكن تسجيل جهاز جديد مكانه.', okLabel: 'حذف', danger: true })) run(() => api(`/developer/tenants/${tenant}/devices/${b.dataset.id}`, { method: 'DELETE' }), 'تم الحذف'); }));
  }
  function bindLicenses() {
    document.querySelectorAll('.lic-co').forEach((box) => {
      const t = box.dataset.t; const v = (c) => box.querySelector(c).value;
      box.querySelectorAll('.lic-preset').forEach((b) => (b.onclick = () => { box.querySelector('.lic-plan').value = b.dataset.plan; box.querySelector('.lic-end').value = ''; box.querySelector('.lic-start').value = ''; }));
      box.querySelector('.lic-save').onclick = () => run(() => api(`/developer/tenants/${t}/license`, { method: 'PUT', body: {
        planType: v('.lic-plan'), startsAt: v('.lic-start') || null, expiresAt: v('.lic-end') ? v('.lic-end') + 'T23:59:59Z' : null, graceDays: v('.lic-grace'), expiredMode: v('.lic-mode'),
        bindingMode: v('.lic-bind'), allowedDomains: v('.lic-dom').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean), maxDevices: v('.lic-dev') || null, maxUsers: v('.lic-users') || null, maxBranches: v('.lic-br') || null, notes: v('.lic-notes') } }), 'تم حفظ الترخيص');
      box.querySelectorAll('.lic-ext').forEach((b) => (b.onclick = () => run(() => api(`/developer/tenants/${t}/license/extend`, { method: 'POST', body: { unit: b.dataset.u, amount: Number(b.dataset.n) } }), 'تم التمديد')));
      const del = box.querySelector('.lic-del'); if (del) del.onclick = async () => { if (await confirmBox({ title: 'إلغاء الترخيص؟', text: 'يعود العميل بلا قيود ترخيص (كالعملاء القدامى) ما لم يكن LICENSE_REQUIRED مفعّلًا. لإيقافه فعليًا استخدم زر الإيقاف.', okLabel: 'إلغاء الترخيص', danger: true })) run(() => api(`/developer/tenants/${t}/license`, { method: 'DELETE' }), 'أُلغي الترخيص'); };
      const dv = box.querySelector('.lic-devs'); if (dv) dv.onclick = async () => { try { renderDevices(box.querySelector('.lic-devbox'), t, await api(`/developer/tenants/${t}/devices`)); } catch (e) { toast(e.message, false); } };
    });
  }

  /* ───────── نشاط الشركات والوحدات ───────── */
  function activityHtml() {
    const a = state.activity; if (!a) return '';
    const base = (code) => new Set((a.profiles.find((p) => p.code === code) || { modules: [] }).modules);
    return `<section class="card"><h2>🏭 نشاط الشركات والوحدات <span class="pill p-info">${a.companies.length}</span></h2>
      <p style="margin:0 0 10px;color:var(--muted,#667)">اختر ملف النشاط (تصنيع، مبيعات فقط، صباغة، تجهيز…) ثم عدّل الوحدات يدويًا عند الحاجة. الإنفاذ من الخادم، وتغيير الملف يعيد التجاوزات.</p>
      ${a.companies.map((c) => { const b = base(c.profile); return `<div class="act-co" data-co="${esc(c.companyId)}" style="border:1px solid #ddd;border-radius:10px;padding:12px;margin-bottom:12px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px"><b>${esc(c.name)}</b><small>${esc(c.tenant || '')}</small>
          <select class="fc act-profile" style="max-width:260px">${a.profiles.map((p) => `<option value="${esc(p.code)}" ${p.code === c.profile ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
          <button class="btn btn-sm btn-gold act-save-profile">تطبيق الملف</button></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:6px">${a.modules.map((m) => `<label style="display:flex;gap:6px;align-items:flex-start;font-size:13px"><input type="checkbox" class="act-mod" data-key="${esc(m.key)}" ${c.modules[m.key] ? 'checked' : ''}><span><b>${esc(m.name)}</b>${c.overrides[m.key] !== undefined ? ' <span class="pill p-warning">مُعدَّل</span>' : ''}<br><small>${esc(m.desc)}</small></span></label>`).join('')}</div>
        <div style="margin-top:8px"><button class="btn btn-sm btn-gold act-save-mods">حفظ الوحدات</button> <button class="btn btn-sm btn-outline act-reset">إعادة لافتراضي الملف</button></div></div>`; }).join('')}
    </section>`;
  }
  function bindActivity() {
    const a = state.activity; if (!a) return;
    document.querySelectorAll('.act-co').forEach((box) => {
      const id = box.dataset.co;
      box.querySelector('.act-save-profile').onclick = () => run(() => api(`/developer/companies/${id}/activity`, { method: 'PUT', body: { profile: box.querySelector('.act-profile').value } }), 'تم تطبيق ملف النشاط');
      box.querySelector('.act-reset').onclick = () => run(() => api(`/developer/companies/${id}/activity`, { method: 'PUT', body: { resetOverrides: true } }), 'أُعيدت الوحدات لافتراضي الملف');
      box.querySelector('.act-save-mods').onclick = () => {
        const prof = a.profiles.find((p) => p.code === box.querySelector('.act-profile').value) || { modules: [] }; const baseSet = new Set(prof.modules);
        const overrides = {}; box.querySelectorAll('.act-mod').forEach((cb) => { const on = cb.checked; overrides[cb.dataset.key] = on === baseSet.has(cb.dataset.key) ? null : on; });
        run(() => api(`/developer/companies/${id}/activity`, { method: 'PUT', body: { profile: box.querySelector('.act-profile').value, overrides } }), 'تم حفظ الوحدات');
      };
    });
  }

  /* ───────── اشتراكات + إشعارات المطوّر + التحديث عن بُعد + الخوادم ───────── */
  function licCell(t) {
    const it = ((state.licenses && state.licenses.items) || []).find((x) => x.tenantId === t.id);
    if (!it) return '<span class="pill p-info">—</span>';
    const m = STATE_AR[it.state] || STATE_AR.none; const l = it.license || {};
    return `<span class="pill ${m[1]}">${m[0]}</span>${l.expiresAt ? `<br><small>${esc(PLAN_AR[l.planType] || l.planType)} · ${esc(dayVal(l.expiresAt))}${it.daysLeft != null ? ` (${Number(it.daysLeft)} يوم)` : ''}</small>` : ''}`;
  }

  const PRESETS = {
    renew: ['تذكير بتجديد الترخيص', 'نذكّركم باقتراب موعد انتهاء الترخيص. للتجديد وتفادي إيقاف الخدمة تواصلوا معنا عبر واتساب: 01014868778'],
    maintenance: ['صيانة مجدولة', 'ستتوقف الخدمة لفترة قصيرة للصيانة والتحسين. نعتذر عن أي إزعاج.'],
    update: ['إصدار جديد متاح', 'تم إصدار تحديث جديد بمزايا وتحسينات. أعد تحميل البرنامج للحصول عليه.'],
  };

  function remoteCardsHtml(d) {
    const u = d.update || {};
    return `<div class="grid g2">
      <section class="card"><h2>🔔 إرسال إشعار / تذكير للعملاء</h2>
        <form id="nf">
          <label>قالب جاهز</label><select class="fc" id="n-preset"><option value="">— اختر —</option><option value="renew">${PRESETS.renew[0]}</option><option value="maintenance">${PRESETS.maintenance[0]}</option><option value="update">${PRESETS.update[0]}</option></select>
          <div class="row2"><div><label>الموجَّه إلى</label><select class="fc" id="n-ten"><option value="">كل العملاء</option>${d.tenants.map((t) => `<option value="${esc(t.id)}">${esc(t.company_name || t.name)}</option>`).join('')}</select></div>
            <div><label>المستلمون</label><select class="fc" id="n-aud"><option value="owners">المالكون فقط</option><option value="all">كل المستخدمين</option></select></div></div>
          <label>العنوان *</label><input class="fc" id="n-title" maxlength="120" required>
          <label>النص</label><textarea class="fc" id="n-body" maxlength="1000"></textarea>
          <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="n-ann"> انشره أيضًا كشريط إعلان في شاشة الدخول</label>
          <button class="btn btn-gold btn-block">📤 إرسال الآن (إشعار داخل النظام + Push)</button>
        </form>
        <div style="margin-top:10px"><button class="btn btn-sm btn-outline" id="run-rem">⏰ تشغيل تذكيرات الترخيص الآن</button> <small>(تعمل تلقائيًا يوميًا: قبل 14/7/3/1 يوم ويوم الانتهاء وخلال فترة السماح)</small></div>
      </section>
      <section class="card"><h2>⬆️ التحديثات عن بُعد</h2>
        <p style="margin:0 0 8px;color:var(--muted,#667)">النشر على Vercel يحدّث الجميع تلقائيًا. هنا تتحكم في <b>إظهار لافتة التحديث</b> أو <b>إجبار</b> الأجهزة القديمة على التحديث قبل العمل.</p>
        <form id="uf">
          <div class="row2"><div><label>أحدث إصدار (لافتة اختيارية)</label><input class="fc" id="u-latest" dir="ltr" placeholder="1.4.0" value="${esc(u.latestVersion || '')}"></div>
            <div><label>أدنى إصدار مسموح (إجباري)</label><input class="fc" id="u-min" dir="ltr" placeholder="1.3.0" value="${esc(u.minVersion || '')}"></div></div>
          <label>رسالة للمستخدمين</label><input class="fc" id="u-msg" maxlength="300" value="${esc(u.message || '')}" placeholder="مثال: تحديث أمني مهم">
          <div class="actions"><button class="btn btn-gold">حفظ</button><button type="button" class="btn btn-red" id="u-force">⚠ إجبار الجميع على أحدث إصدار</button></div>
          <small>تنبيه: ارفع رقم الإصدار في frontend/package.json وانشر قبل تحديد أدنى إصدار؛ وإلا سيُمنع الجميع.</small>
        </form>
      </section>
    </div>`;
  }

  /* نافذة عامة بنموذج */
  function formModal({ title, bodyHtml, okLabel = 'حفظ', extraButtons = '' }) {
    return new Promise((resolve) => {
      const bg = document.createElement('div'); bg.className = 'modal-bg';
      bg.innerHTML = `<form class="modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3>${bodyHtml}<div class="actions"><button type="button" class="btn btn-outline" data-x="cancel">إلغاء</button>${extraButtons}<button class="btn btn-green">${esc(okLabel)}</button></div></form>`;
      document.body.appendChild(bg);
      const done = (v) => { bg.remove(); resolve(v); };
      bg.addEventListener('click', (e) => { if (e.target === bg || e.target.dataset?.x === 'cancel') done(null); });
      bg.querySelector('form').onsubmit = (e) => { e.preventDefault(); done({ el: bg, submit: true }); };
      bg.querySelectorAll('[data-x]').forEach((b) => { if (b.dataset.x !== 'cancel') b.onclick = () => done({ el: bg, action: b.dataset.x }); });
      bg.querySelector('input,select,textarea')?.focus();
    });
  }

  async function pingServer(url) {
    const t0 = performance.now();
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 6000);
      const res = await fetch(`${url}/health`, { cache: 'no-store', signal: ctl.signal }); clearTimeout(timer);
      return res.ok ? { ok: true, ms: Math.round(performance.now() - t0) } : { ok: false, ms: 0 };
    } catch { return { ok: false, ms: 0 }; }
  }

  function serversModal(onChange) {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    const draw = () => {
      const list = servers.list();
      bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="max-width:640px"><h3>🖧 خوادم العملاء</h3>
        <p style="margin:0 0 8px;color:var(--muted,#667)">لكل عميل نشر مستقل (قاعدة بيانات + باك إند). أضف عنوان كل عميل هنا للتنقل بينهم وفحص حالتهم.</p>
        <div class="tbl"><table><thead><tr><th>العميل</th><th>الحالة</th><th></th></tr></thead><tbody>
        ${list.length ? list.map((s, i) => `<tr><td><b>${esc(s.name)}</b><br><code dir="ltr">${esc(s.url)}</code></td><td data-ping="${i}">…</td>
          <td><div class="actions"><button class="btn btn-sm ${s.url === apiBase() ? 'btn-green' : 'btn-gold'}" data-open="${i}">${s.url === apiBase() ? 'الحالي' : 'فتح'}</button><button class="btn btn-sm btn-red" data-rm="${i}">حذف</button></div></td></tr>`).join('') : '<tr><td colspan="3" class="empty">لا خوادم محفوظة</td></tr>'}
        </tbody></table></div>
        <form id="srv-add" style="margin-top:10px"><div class="row2"><div><label>اسم العميل</label><input class="fc" id="sv-name" maxlength="60" required></div><div><label>عنوان الباك إند (https)</label><input class="fc" id="sv-url" dir="ltr" placeholder="https://client1-api.vercel.app" required></div></div>
        <div class="actions"><button class="btn btn-gold">+ إضافة</button><button type="button" class="btn btn-outline" id="sv-close">إغلاق</button></div></form></div>`;
      bg.querySelector('#sv-close').onclick = () => { bg.remove(); onChange?.(); };
      bg.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => { selectServer(list[Number(b.dataset.open)].url); bg.remove(); if (state.token) load(); else renderLogin(); }));
      bg.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { servers.save(list.filter((_, i) => i !== Number(b.dataset.rm))); draw(); }));
      bg.querySelector('#srv-add').onsubmit = (e) => {
        e.preventDefault();
        try {
          const url = servers.normalize(bg.querySelector('#sv-url').value);
          if (list.some((s) => s.url === url)) throw new Error('هذا الخادم مضاف بالفعل');
          servers.save([...list, { name: bg.querySelector('#sv-name').value.trim(), url }]); draw();
        } catch (err) { toast(err.message, false); }
      };
      list.forEach(async (s, i) => { const r = await pingServer(s.url); const c = bg.querySelector(`[data-ping="${i}"]`); if (c) c.innerHTML = r.ok ? `<span class="pill p-on">يعمل · ${r.ms}ms</span>` : '<span class="pill p-off">لا يستجيب</span>'; });
    };
    document.body.appendChild(bg); draw();
  }

  function bindRemote() {
    document.getElementById('servers').onclick = () => serversModal();

    document.getElementById('n-preset').onchange = (e) => { const p = PRESETS[e.target.value]; if (p) { document.getElementById('n-title').value = p[0]; document.getElementById('n-body').value = p[1]; } };
    document.getElementById('nf').onsubmit = async (e) => {
      e.preventDefault();
      const tenant = document.getElementById('n-ten').value || null;
      const label = tenant ? document.getElementById('n-ten').selectedOptions[0].textContent : 'كل العملاء';
      if (!(await confirmBox({ title: 'إرسال الإشعار؟', text: `سيصل إلى: ${label} (${document.getElementById('n-aud').selectedOptions[0].textContent}) كإشعار داخل النظام + Push.`, okLabel: 'إرسال' }))) return;
      run(async () => {
        const r = await api('/developer/notify', { method: 'POST', body: { tenantId: tenant, audience: document.getElementById('n-aud').value, title: document.getElementById('n-title').value, body: document.getElementById('n-body').value, alsoAnnouncement: document.getElementById('n-ann').checked } });
        toast(`وصل إلى ${r.recipients} مستخدم`);
      }, 'تم الإرسال');
    };
    document.getElementById('run-rem').onclick = () => run(async () => { const r = await api('/developer/reminders/run', { method: 'POST', body: {} }); toast(`أُرسل ${r.sent} تذكير`); }, 'اكتمل تشغيل التذكيرات');

    const saveUpdate = (latest, min) => run(() => api('/developer/update', { method: 'PUT', body: { latestVersion: latest, minVersion: min, message: document.getElementById('u-msg').value } }), 'تم حفظ سياسة التحديث');
    document.getElementById('uf').onsubmit = (e) => { e.preventDefault(); saveUpdate(document.getElementById('u-latest').value.trim(), document.getElementById('u-min').value.trim()); };
    document.getElementById('u-force').onclick = async () => {
      const latest = document.getElementById('u-latest').value.trim();
      if (!latest) return toast('حدّد «أحدث إصدار» أولًا', false);
      if (await confirmBox({ title: 'إجبار التحديث؟', text: `ستُمنع كل النسخ الأقدم من ${latest} من العمل حتى تُحدَّث. تأكد أنك نشرت هذا الإصدار على الخادم.`, okLabel: 'نعم، أجبر الجميع', danger: true })) saveUpdate(latest, latest);
    };
  }


  async function run(fn, okMsg) {
    try { await fn(); toast(okMsg); await load(); } catch (e) { toast(e.message, false); }
  }

  function bind() {
    const d = state.data;
    document.getElementById('out').onclick = logout;
    bindActivity();
    bindLicenses();
    bindClients();
    bindRemote();
    document.getElementById('refresh').onclick = () => load().then(() => toast('تم التحديث'));

    document.getElementById('master').onclick = async () => {
      const on = d.global.status === 'active';
      const r = await confirmBox(on
        ? { title: 'إيقاف المنصة بالكامل؟', text: 'سيُمنع جميع العملاء من الدخول والعمل فورًا، وتُقطع جلساتهم عند أول طلب. تأكد من رغبتك.', okLabel: 'نعم، أوقف الكل', danger: true, withMessage: true, messageDefault: d.global.message }
        : { title: 'إعادة تشغيل المنصة؟', text: 'سيعود جميع العملاء (غير الموقوفين فرديًا) للعمل فورًا.', okLabel: 'إعادة التشغيل' });
      if (r) run(() => api('/developer/service', { method: 'PUT', body: { status: on ? 'suspended' : 'active', message: r.message } }), on ? 'تم إيقاف المنصة' : 'تم تشغيل المنصة');
    };

    document.querySelectorAll('[data-tenant]').forEach((b) => (b.onclick = async () => {
      const to = b.dataset.to; const sus = to === 'suspended';
      const r = await confirmBox({ title: `${sus ? 'إيقاف' : 'تشغيل'} العميل «${b.dataset.name}»؟`, text: sus ? 'سيُمنع هذا العميل فقط من الدخول والعمل، دون التأثير على بقية العملاء.' : 'سيعود هذا العميل للعمل فورًا.', okLabel: sus ? 'إيقاف' : 'تشغيل', danger: sus, withMessage: sus });
      if (r) run(() => api(`/developer/tenants/${b.dataset.tenant}/service`, { method: 'PUT', body: { status: to, message: r.message } }), sus ? 'تم إيقاف العميل' : 'تم تشغيل العميل');
    }));

    document.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('تم نسخ المعرّف')); }));

    document.querySelectorAll('[data-ann-toggle]').forEach((b) => (b.onclick = () =>
      run(() => api(`/developer/announcements/${b.dataset.annToggle}`, { method: 'PATCH', body: { isActive: b.dataset.active !== 'true' } }), 'تم التحديث')));
    document.querySelectorAll('[data-ann-del]').forEach((b) => (b.onclick = async () => {
      if (await confirmBox({ title: 'حذف الإشعار؟', text: 'سيُحذف نهائيًا من شاشة الدخول.', okLabel: 'حذف', danger: true })) run(() => api(`/developer/announcements/${b.dataset.annDel}`, { method: 'DELETE' }), 'تم الحذف');
    }));

    document.getElementById('af').onsubmit = (e) => {
      e.preventDefault();
      const iso = (id) => { const v = document.getElementById(id).value; return v ? new Date(v).toISOString() : null; };
      run(() => api('/developer/announcements', { method: 'POST', body: {
        title: document.getElementById('a-title').value, body: document.getElementById('a-body').value,
        severity: document.getElementById('a-sev').value, tenantId: document.getElementById('a-ten').value || null,
        startsAt: iso('a-start'), endsAt: iso('a-end') } }), 'تم نشر الإشعار');
    };
  }

  if (!servers.list().length && apiBase()) servers.save([{ name: 'الخادم الحالي', url: apiBase() }]);
  if (state.token) load(); else renderLogin();
  // تحديث تلقائي هادئ كل دقيقة
  setInterval(() => { const typing = ['a-title', 'a-body', 'n-title', 'n-body', 'u-msg'].some((id) => document.getElementById(id)?.value);
    if (state.token && document.visibilityState === 'visible' && !typing && !document.querySelector('.modal-bg') && !document.activeElement?.closest?.('.lic-co,.act-co,.cl-co,#newClient,#frontUrl') && !document.querySelector('.cl-co[open], details[open] #newClient')) load(); }, 60000);
})();
