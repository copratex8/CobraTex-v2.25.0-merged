#!/usr/bin/env bash
# فحص ما قبل التجربة: يثبّت الحزم، يفحص الأنواع، يبني، ويشغّل الاختبارات. شغّله من جذر المشروع.
# الاستخدام: DATABASE_URL=postgres://... bash tools/preflight.sh
set -euo pipefail
step(){ echo; echo "=== $1 ==="; }
step "1) الأسرار والمخطط";  node tools/secret-scan.mjs; node tools/check-schema.mjs
step "2) الباك إند: تثبيت + أنواع + بناء"
(cd backend && npm install && npx tsc --noEmit && npm run build --if-present)
step "3) الواجهة: تثبيت + بناء (tsc -b + vite)"
(cd frontend && npm install && npm run build)
if [ -n "${DATABASE_URL:-}" ]; then
  step "4) الهجرات + اختبارات الباك إند"
  (cd backend && npm run migrate && npm test)
else
  echo "تخطّي الاختبارات: اضبط DATABASE_URL لقاعدة اختبار فارغة"
fi
if command -v psql >/dev/null && [ -n "${DATABASE_URL:-}" ]; then
  step "5) اختبارات RLS (قاعدة Supabase تجريبية فقط)"
  for f in supabase/tests/*.sql; do echo "-- $f"; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
fi
echo; echo "✔ اكتمل الفحص — ولا تنسَ commit لملفي package-lock.json"
