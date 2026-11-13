# ملاحظات الدمج — الإصدار 2.25.0

دُمج مشروعان: **A** = `CobraTex-v2.24.1` (الأساس) و**B** = `cobratex-ready` (2.20/2.21 بطبقة Supabase الأصلية).

## ما أُخذ من A
تراخيص (`tenant_licenses`, `license_devices`)، هوية لكل عميل، المرفقات عبر الـAPI إلى Supabase Storage، إدارة المستخدمين، `provisioning`، التصليب الأمني، اختبارات `docs/qa`، تطبيق Electron الكامل بلا إنترنت (أُعيدت تسميته `desktop-offline/`).

## ما أُخذ من B
Supabase Auth + `custom_access_token_hook` وسياسات RLS وRealtime، مفتاح الإيقاف والتحكم عن بُعد، `supabaseAuth.ts` وTOTP/IP allowlist للوحة المطور، PWA (`vite-plugin-pwa` + `sw/sw.ts`)، `desktop-shell/`، أدوات `tools/`، وسير عمل CI/النسخ الاحتياطي/المراقبة، وتذكيرات الاشتراك.

## قرارات الدمج
| الموضوع | القرار |
|---|---|
| المصادقة | وضعان وقت البناء `VITE_AUTH_MODE=legacy\|supabase`؛ الخادم يقبل JWT من Supabase إن ضُبط `SUPABASE_URL`، ويحتفظ بالدخول القديم ما لم `DISABLE_LEGACY_LOGIN=true` |
| الاشتراك/الانتهاء | **الترخيص** هو المصدر الوحيد؛ التذكيرات وحجب RLS مبنية على `tenant_licenses` (هجرة 0074 + `supabase/..._08`) |
| المرفقات | عبر الـAPI فقط (bucket خاص بلا سياسات مباشرة)؛ استُبدل الرفع المباشر من المتصفح |
| Realtime | `RealtimeBridge` موحّد؛ في الوضع legacy يُستخدم `/realtime/token` ويحمل `company_id`/`tenant_id` لتعمل RLS |
| تثبيت PWA | `installStore` + `InstallAppButton` من B؛ حُذف `InstallApp.tsx` و`public/sw.js` و`manifest` اليدوي |
| Electron | `desktop-offline/` (كامل) و`desktop-shell/` (غلاف رفيع) |
| النسخ الاحتياطي | `tools/restore-backup.sh` بدل سكربت التمرين القديم |

## أُزيل لتجنب التكرار
`scripts/` القديم، `docs/PACK-V1/V2`، `docs/supabase/`، `enable-realtime.mjs`، `desktop/DEPRECATED.md`، ملفات `package-lock.json` (تُولَّد لاحقًا).

## ⚠ أول تشغيل (إلزامي)
1. `cd backend && npm install` ثم `cd ../frontend && npm install`، واعمل commit لملفي `package-lock.json` الناتجين.
2. `npm run migrate` في الباك إند ثم هجرات `supabase/migrations` (إن اخترت وضع Supabase).
3. راجع `docs/GO-LIVE_AR.md`.

## ما لم يُختبر أثناء الدمج
لم يُشغَّل: `npm install`، فحص الأنواع مع الاعتمادات، اختبارات الباك إند، هجرات SQL واختبارات RLS، بناء الواجهة/PWA (بيئة بلا شبكة). المُتحقَّق منه: صياغة 414 ملف TS/TSX، وصحة JS/JSON/YAML، وتطابق الاستيراد/التصدير. إصدارات `vite-plugin-pwa` و`@supabase/supabase-js` و`jose` و`workbox` اختيرت بنطاقات واسعة وتحتاج تأكيدًا عند أول تثبيت.

## فحص ما قبل التجربة
شغّل `bash tools/preflight.sh` (مع `DATABASE_URL` لقاعدة اختبار) لتنفيذ: فحص الأسرار والمخطط ← أنواع الباك إند والبناء ← بناء الواجهة ← الهجرات واختبارات الباك إند ← اختبارات RLS.
