# النسخ الاحتياطي وربط Google Drive

## ما الذي يُنسخ؟
قاعدة البيانات كاملة (كل الجداول عدا `_migrations` وإعدادات النسخ نفسها) في ملف واحد `cobratex-YYYY-MM-DD_HH-MM-SS.cbk`
(gzip لأسطر JSON). لا يحتاج `pg_dump`، فيعمل داخل الـexe وعلى Vercel. اللقطة متّسقة (معاملة REPEATABLE READ).
الاستعادة داخل معاملة واحدة: إما تنجح كلها أو لا يتغيّر شيء، وتُنشأ **نسخة أمان تلقائية قبلها**.

## من الواجهة: النظام ← النسخ الاحتياطي
| الإجراء | التفصيل |
|---|---|
| نسخة الآن | تُحفظ محليًا في مجلد النسخ |
| نسخة + رفع إلى Drive | محليًا ثم رفع إلى مجلد Drive؛ فشل Drive لا يُسقط النسخة المحلية (الحالة «محلية فقط») |
| تنزيل / حذف | لكل نسخة محلية |
| استعادة من ملف | ارفع ملف `.cbk` (مثلًا نزّلته من Drive يدويًا) واكتب `RESTORE` للتأكيد |
| استعادة من Drive | من قائمة «عرض نسخ Drive» |
| نسخ يومي تلقائي | يعمل أثناء تشغيل البرنامج (exe/Render/Docker)، لا على Vercel (لا عملية دائمة) |
| الاحتفاظ بآخر N | يُطبَّق محليًا وعلى Drive (الافتراضي 14) |

## النسخ اليدوي إلى Drive بلا أي ربط
نزّل ملف `.cbk` من الصفحة وارفعه بنفسك إلى Drive. للاستعادة استخدم «استعادة من ملف».

## ربط Google Drive (مرة واحدة، مجاني)
1. console.cloud.google.com ← مشروع جديد ← فعّل **Google Drive API**.
2. OAuth consent screen: External، وأضف بريدك مستخدمًا تجريبيًا (Test users).
3. Credentials ← OAuth client ID ← **Web application**.
4. في **Authorized redirect URIs** ضع العنوان الظاهر في صفحة النسخ الاحتياطي (تفاصيل «كيف أحصل…»). أمثلة:
   - exe: `http://localhost:47600/api/backup/google/callback`
   - سحابي: `https://<backend>.vercel.app/api/backup/google/callback` (واضبط `PUBLIC_API_URL`)
5. انسخ Client ID وSecret إلى الصفحة ← حفظ ← «ربط Google Drive» ← وافق.

النطاق المطلوب `drive.file` فقط: لا يرى البرنامج إلا الملفات التي أنشأها. الأسرار تُخزَّن مشفّرة AES‑256‑GCM
(`BACKUP_ENC_KEY` أو مشتقة من `JWT_REFRESH_SECRET`؛ تغييره يستلزم إعادة الربط).
ملاحظة: مشروع OAuth في وضع «Testing» تنتهي صلاحية رمزه بعد 7 أيام؛ انشر الشاشة إلى «In production» لتجنّب إعادة الربط.

## لماذا بلا مكتبة googleapis؟
التكامل يستخدم REST الرسمي لـ Google عبر `fetch` المدمج في Node 22/Electron: لا حزمة إضافية (googleapis وحدها >100MB)،
فهو مضمَّن في الـexe تلقائيًا ويعمل على Vercel. الكود في `backend/src/modules/backup/driveService.ts`.

## الأمان
- الصلاحية `system.backup.manage` (مُمنوحة لأدوار Owner). المسارات `/api/backup/*`.
- النسخة تشمل **كل** العملاء، لذا تُرفض افتراضيًا إذا وُجد أكثر من مستأجر في القاعدة (نشر مشترك).
  للسماح: `BACKUP_ALLOW_MULTI_TENANT=true` (مسؤوليتك).
- الاستعادة تتطلب إرسال `confirm: "RESTORE"`.
- ملف `.cbk` غير مشفَّر: يحوي بيانات النظام كلها (وتجزئات كلمات المرور). احفظه في مكان خاص.
