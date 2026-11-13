# التحوّل إلى Supabase (بعد الدمج 2.25.0)

كل ما كان قوالب منفصلة صار جزءًا من المشروع:

- **قاعدة البيانات والـAuth والـRLS والـRealtime:** `supabase/migrations/20261106000001..09` (شغّلها بالترتيب بعد `npm run migrate` للباك إند).
- **المصادقة:** اضبط `VITE_AUTH_MODE=supabase` في الواجهة و`SUPABASE_URL` (+`SUPABASE_JWT_SECRET` للنمط القديم) في الباك إند. للتحوّل الكامل أضف `DISABLE_LEGACY_LOGIN=true` بعد التأكد من دخول كل المستخدمين.
- **المرفقات:** تبقى عبر الـAPI (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`)؛ الـbucket خاص ولا سياسات مباشرة. للنقل من BYTEA: `npm run attachments:to-storage`.
- **Realtime:** `RealtimeBridge` يعمل تلقائيًا؛ في وضع legacy يُصدر الخادم توكنًا قصيرًا عبر `/api/realtime/token`.
- **التذكيرات:** pg_cron `cobratex-license-reminders` (أو `/api/cron/license-reminders` على Vercel بـ`CRON_SECRET`).
- **Electron:** `desktop-offline/` (بلا إنترنت) و`desktop-shell/` (غلاف رفيع) — انظر `docs/DESKTOP-EXE.md`.

لا يُنصح بحذف طبقة Express: هي مصدر التراخيص والمرفقات والتدقيق. التفاصيل: `docs/GO-LIVE_AR.md` و`docs/MERGE-NOTES_AR.md`.
