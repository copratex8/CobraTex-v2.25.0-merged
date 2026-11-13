# دليل الإطلاق (Go-Live) — CobraTex على Supabase + Vercel

> الترتيب مهم. نفّذ كل شيء أولًا على **Staging**، ولا تلمس الإنتاج قبل نجاح `tools/smoke-test.mjs` عليه.
> هذا المشروع هو **الوضع الهجين**: Supabase (قاعدة + مصادقة + تخزين + Realtime) + PWA + Express كدالة Serverless. جاهز للنشر كما هو.

## 0) قبل البدء (10 دقائق)
- حساب GitHub (مستودع **خاص**)، Supabase، Vercel.
- **خطة Vercel:** خطة Hobby المجانية مخصصة حسب شروط Vercel للاستخدام الشخصي/غير التجاري؛ لنظام تجاري راجع الشروط وقد تحتاج Pro (≈ 20$/شهر). بديل مجاني للاستخدام التجاري للواجهة: Cloudflare Pages (يتطلب نقل `vercel.json` لإعدادات مكافئة).
- **خطة Supabase:** للإنتاج Pro (نسخ احتياطية يومية، بلا إيقاف تلقائي). Free للتجربة فقط.
- مولّد أسرار: `openssl rand -base64 48` (تحتاج 3: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `BOOTSTRAP_SECRET`).

## 1) المستودع
```bash
cd cobratex
git init && git add -A && git commit -m "CobraTex: Supabase + PWA"
git remote add origin git@github.com:YOU/cobratex.git && git push -u origin main
```
افتح تبويب **Actions**: يجب أن تنجح الوظائف الثلاث في `Supabase checks` (contract / sql / pwa). **إن فشلت فلا تكمل** — أرسل لي سجل الخطأ. هذا هو الاختبار الحقيقي الأول لملفات SQL.

## 2) Supabase (Staging أولًا)
1. New project → اختر المنطقة الأقرب لمستخدميك → احفظ كلمة مرور القاعدة.
2. **Authentication → Sign In / Providers → عطّل «Allow new users to sign up»** (أساسي: المفتاح العام anon يستطيع التسجيل وإلا).
3. من **Project Settings → API**: انسخ `Project URL` و`anon/publishable key`.
4. من **Connect**: انسخ سلاسل الاتصال — *Session pooler* (منفذ 5432) للأوامر اليدوية، و*Transaction pooler* (منفذ 6543) لـ Vercel.
5. إعداد القاعدة، **أحد المسارين**:
   - **A) عندك بيانات قديمة:**
     ```bash
     pg_dump "$OLD_DATABASE_URL" --schema=public --no-owner --no-privileges -Fc -f cobratex.dump
     pg_restore --no-owner --no-privileges -d "$SB_SESSION_URL" cobratex.dump
     ```
     ثم قارن عدد الصفوف وميزان المراجعة بين النظامين.
   - **B) بداية جديدة:** `cd backend && DATABASE_URL="$SB_SESSION_URL" npm run migrate`
6. شغّل ملفات `supabase/migrations/*.sql` **بالترتيب 01 → 09** (بعد تشغيل `npm run migrate` للباك إند أولًا، إذ تعتمد 08 على جدول `tenant_licenses` من هجرة 0071) (`psql "$SB_SESSION_URL" -v ON_ERROR_STOP=1 -f <file>` أو SQL Editor).
7. **Authentication → Hooks → Custom Access Token** ← اختر `public.custom_access_token_hook` وفعّله.
8. (مسار B فقط) أنشئ الشركة الأولى عبر `/bootstrap` بعد نشر الباك إند (الخطوة 3) باستخدام `BOOTSTRAP_SECRET`؛ الـ Trigger سيزامن المستخدم إلى Supabase Auth تلقائيًا.
9. اختبر العزل على القاعدة نفسها (اختياري لكنه موصى به، يُلغى تلقائيًا):
   `psql "$SB_SESSION_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_isolation.sql` ← يجب أن يطبع `ALL CHECKS PASSED`.

## 3) الباك إند على Vercel (مشروع رقم 2)
Add New → Project → نفس المستودع → **Root Directory = `backend`** (يستخدم `vercel.json` الموجود: Serverless + `/api/*`).

| المتغير | القيمة |
|---|---|
| `DATABASE_URL` | **Transaction pooler** (6543) |
| `DB_POOL_MAX` | `1` |
| `DATABASE_SSL` | `auto` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | أسرار عشوائية طويلة (ما زالت مطلوبة: مسار الدخول القديم ولوحة المطور) |
| `BOOTSTRAP_SECRET` | سر عشوائي طويل — **إلزامي في الإنتاج** (بدونه يستطيع أي شخص إنشاء مستأجرين) |
| `NODE_ENV` | `production` |
| `SUPABASE_URL` | `https://<ref>.supabase.co` ← يفعّل قبول توكن Supabase |
| `CORS_ORIGINS` | نطاق الواجهة (وأي لوحة مطور) مفصولة بفواصل |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | إن استخدمت الإشعارات (نفس مفاتيحك الحالية) |

بعد النشر: افتح `https://<backend>.vercel.app/health` ← `{"status":"ok"}`.
> إن ظهرت أخطاء اتصال/معاملات مع Transaction pooler، بدّل `DATABASE_URL` إلى **Session pooler** (5432) مع `DB_POOL_MAX=2`.

## 4) الواجهة على Vercel (مشروع رقم 1)
**Root Directory = `frontend`** · Framework: Vite.

| المتغير | القيمة |
|---|---|
| `VITE_SUPABASE_URL` | Project URL |
| `VITE_SUPABASE_ANON_KEY` | anon/publishable key |
| `VITE_AUTH_MODE` | `supabase` (الافتراضي `legacy`؛ يرجع تلقائيًا لـlegacy إن غاب مفتاحا Supabase) |
| `VITE_API_BASE_URL` | `https://<backend>.vercel.app/api` (بدون `/` أخيرة) |

> **لا تضع `service_role` في أي متغير إطلاقًا.** أي تغيير للمتغيرات يحتاج Redeploy (تُدمج وقت البناء).

## 5) ربط Supabase بنطاق الواجهة
Authentication → URL Configuration: **Site URL** = نطاق الواجهة. أضف نفس النطاق (وروابط الـ Preview إن أردت) في Redirect URLs.
ثم أضف نطاق الواجهة في `CORS_ORIGINS` للباك إند وأعد نشره.

## 6) اختبار الدخان على البيئة المنشورة
```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=... \
API_URL=https://<backend>.vercel.app/api SITE_URL=https://<frontend>.vercel.app \
TEST_EMAIL=... TEST_PASSWORD=... node tools/smoke-test.mjs
```
يجب أن ينتهي بـ `ALL CHECKS PASSED`. يفحص: الدخول بكلمة المرور القديمة، الـ JWT، منع `password_hash` و`audit_logs` والكتابة المباشرة، عزل الشركة، قبول Express للتوكن، وتقديم `manifest`/`sw.js` بالترويسات الصحيحة.

## 7) اختبار يدوي (15 دقيقة)
- [ ] دخول بمستخدمين من شركتين مختلفتين؛ لا يرى أحدهما بيانات الآخر.
- [ ] ترحيل فاتورة مبيعات في جهاز وظهورها لحظيًا في جهاز آخر (Realtime).
- [ ] رفع PDF وصورة وفتحهما وحذفهما.
- [ ] إنشاء مستخدم جديد من شاشة الإدارة ثم دخوله.
- [ ] تثبيت التطبيق: Android (Chrome) · Windows (Edge/Chrome) · iPhone (مشاركة ← إضافة إلى الشاشة الرئيسية).
- [ ] قطع الإنترنت: يظهر الشريط الأحمر وصفحة offline عند إعادة التحميل.
- [ ] الجوال: الجداول تتحول لبطاقات، والقائمة الجانبية منزلقة.
- [ ] إيقاف العميل من لوحة المطور ← تظهر شاشة الإيقاف خلال دقيقة؛ ثم إعادة التشغيل.
- [ ] نسخة احتياطية: شغّل `db-backup.yml` يدويًا (Actions → Run workflow) وتأكد من وجود الملف المشفر.

## 8) الانتقال للإنتاج
1. كرر الخطوات 2–6 على مشروع Supabase الإنتاج (ويُفضَّل Pro) ومشروعي Vercel منفصلين، أو فعّل Environments.
2. حدّد نافذة صيانة: أوقف الإدخال في النظام القديم → `pg_dump` نهائي → استعادة → ميزان المراجعة يتطابق → حوّل المستخدمين للرابط الجديد.
3. أضف أسرار GitHub: `SUPABASE_DB_URL` (Session pooler) و`BACKUP_PASSPHRASE` (احتفظ بها في مدير كلمات مرور — بدونها لا تُفك النسخ).
4. أبقِ النظام القديم للقراءة فقط أسبوعين كخطة تراجع.

## 9) التراجع
- الواجهة/الباك إند: Vercel → Deployments → Promote لإصدار سابق (ثوانٍ).
- القاعدة: قاعدتك القديمة لم تُمسّ (النقل نسخ لا نقل). ارجع بتوجيه `DATABASE_URL` والمستخدمين للنظام القديم.

## 10) بعد الإطلاق
- راقب: Supabase → Reports (حجم القاعدة 500MB على Free، رسائل Realtime)، وVercel → Logs.
- المرحلة التالية (اختيارية): نقل منطق الترحيل من Express إلى دوال Postgres تدريجيًا.

---
### ملاحظات تشغيلية
- التطوير المحلي للواجهة: أنشئ `frontend/.env.local` (مُتجاهَل من git) بالمتغيرات الثلاثة أعلاه.
- التطوير المحلي للباك إند: انسخ `backend/.env.supabase.example` إلى `backend/.env` واضبط `DATABASE_URL` على Session pooler أو قاعدة محلية.
- لتشغيل Supabase محليًا بالكامل (Docker): `supabase init && supabase start` ثم طبّق migrations الباك إند فملفات `supabase/migrations`.

---
## 11) تشديد الأمان (إلزامي قبل أول عميل) — راجع `docs/SECURITY_AR.md`
متغيرات إضافية للباك إند على Vercel:

| المتغير | القيمة |
|---|---|
| `DISABLE_LEGACY_LOGIN` | `true` (بعد التأكد أن الدخول عبر Supabase يعمل) |
| `DEVELOPER_SECRET` | سر ≥ 24 حرفًا (لوحة المطور) |
| `CORS_ORIGINS` | **يجب أن يتضمن أيضًا رابط لوحة المطور** وإلا ستتوقف عن العمل |

للواجهة: `VITE_CSP=on` (فعّله على Staging أولًا وراقب Console بحثًا عن «Refused to…»).

تشغيل اختبار الدخان بعد الإعداد الكامل:
```bash
EXPECT_LEGACY_LOGIN_DISABLED=true EXPECT_CSP=on SUPABASE_URL=... SUPABASE_ANON_KEY=... \
API_URL=https://<backend>.vercel.app/api SITE_URL=https://<frontend>.vercel.app \
TEST_EMAIL=... TEST_PASSWORD=... node tools/smoke-test.mjs
```

## 12) تسليم العميل
- **رابط:** أعطه رابط الواجهة + بيانات دخوله (أنشئ شركته عبر `/bootstrap` بسرّك).
- **ملف exe:** Actions → *Build Windows installer* → أدخل رابط العميل واسمه → حمّل الملف من Artifacts وأرسله.


---
## 13) التحكم عن بُعد وتعدد العملاء
- متغيرات الباك إند الإضافية: `DEVELOPER_TOTP_SECRET` (2FA)، `CRON_SECRET` (تذكيرات الترخيص)، `DEVELOPER_IP_ALLOWLIST` (اختياري). **أسهل طريقة:** `bash tools/new-client.sh <slug> <SESSION_POOLER_URL>` يولّدها كلها لكل عميل.
- التراخيص والإشعارات والتحديث الإجباري وتواصل واتساب واختصار التطبيق وإدارة المستخدمين: `docs/OPERATIONS_AR.md`.
- نشر مستقل لكل عميل، وتحديثهم جميعًا بضغطة، والنسخ الاحتياطي: `docs/MULTI-CLIENT_AR.md`.
- أول مستخدم (المالك) يُنشأ عبر `/bootstrap`؛ بقية المستخدمين وصلاحياتهم من **النظام ← المستخدمون والصلاحيات**.
