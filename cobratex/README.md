# CobraTex ERP — v2.25.0

نظام ERP للنسيج والمؤسسات: Node/Express + PostgreSQL، واجهة React/Vite (PWA)، لوحة مطور، تراخيص، تعدد عملاء، ونمطا مصادقة (legacy / Supabase).

## الهيكل
`backend/` الخادم والهجرات · `frontend/` الواجهة · `developer-panel/` لوحة المطور · `supabase/` هجرات واختبارات وEdge Function · `desktop-shell/` غلاف سطح المكتب · `desktop-offline/` نسخة بلا إنترنت · `tools/` أدوات التشغيل · `docs/` التوثيق.

## البدء
```
cd backend  && npm install && npm run migrate
cd ../frontend && npm install
```
ثم اعمل commit لملفي `package-lock.json`. انسخ `.env.example` في كل مجلد واتبع `docs/GO-LIVE_AR.md`. تفاصيل الدمج وحدوده: `docs/MERGE-NOTES_AR.md`.
