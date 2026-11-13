// إضافة الواجهة الأمامية — ملف JS خام يُقدَّم كأصل ثابت (Static Asset) عبر الباك إند نفسه، ويُحمَّل
// بالمتصفح عبر import() ديناميكي وقت التشغيل. لا يعتمد على React أو أي حزمة من التطبيق المضيف
// إطلاقًا — يُعرِّف Web Component قياسي (Custom Element)، فيعمل داخل أي تطبيق مضيف (React/Vue/بلا
// أي إطار) بلا حاجة لمشاركة نسخة React، وبلا أي إعادة بناء/تغليف للتطبيق المضيف عند إضافته أو
// تحديثه — فقط استبدال هذا الملف على الخادم.

class HelloActivityWidget extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: 'open' });
    this.render('...جارٍ التحميل');
    this.load();
  }

  async load() {
    const token = this.getAttribute('auth-token');
    const apiBase = this.getAttribute('api-base') || '/api';
    try {
      const res = await fetch(`${apiBase}/plugins/hello-activity/ping`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      this.render(data.message, data.loadedAt);
    } catch (err) {
      this.render('تعذَّر الاتصال بالإضافة: ' + err.message);
    }
  }

  render(message, time) {
    this.shadowRoot.innerHTML = `
      <style>
        .card { font-family: sans-serif; padding: 16px; border: 1px solid #e2e8f0; border-radius: 12px; background: #f8fafc; direction: rtl; }
        .badge { display: inline-block; font-size: 11px; background: #0f172a; color: white; padding: 2px 8px; border-radius: 999px; margin-bottom: 8px; }
        .msg { font-size: 14px; color: #0f172a; }
        .time { font-size: 11px; color: #64748b; margin-top: 6px; }
      </style>
      <div class="card">
        <span class="badge">إضافة خارجية (Plugin)</span>
        <div class="msg">${message}</div>
        ${time ? `<div class="time">${time}</div>` : ''}
      </div>
    `;
  }
}

if (!customElements.get('hello-activity-widget')) {
  customElements.define('hello-activity-widget', HelloActivityWidget);
}
