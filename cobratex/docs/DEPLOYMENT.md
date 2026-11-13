# النشر السحابي المجاني

| الطبقة | الخدمة | الملف الجاهز |
|---|---|---|
| قاعدة البيانات | **Supabase** (PostgreSQL مجاني) | — (الترحيلات تُطبَّق بـ `npm run migrate`) |
| الباك إند | **Vercel Serverless** (أو Render Free) | `backend/vercel.json` + `backend/api/index.js` (أو `backend/render.yaml`) |
| الواجهة | **Vercel** | `frontend/vercel.json` (بديل: `netlify.toml`) |
| لوحة المطور | **Vercel** مشروع منفصل | `developer-panel/vercel.json` |

> **Firebase غير مدعوم:** النواة تعتمد PostgreSQL (معاملات + قيود محاسبية). Firestore لا يصلح لها. Supabase هو الخيار المجاني المطابق.

## 1) Supabase
1. أنشئ مشروعًا → **Project Settings → Database → Connection string**.
2. انسخ رابط **Session pooler** (المنفذ 5432، يعمل على IPv4) للاستضافة التقليدية، أو **Transaction pooler** (6543) لـ Vercel Serverless. استبدل `[YOUR-PASSWORD]` (رمّز الرموز الخاصة بـ URL-encoding).
3. من جهازك طبّق الترحيلات مرة واحدة (وبعد كل تحديث يضيف ترحيلًا):
   ```bash
   cd backend && npm install
   DATABASE_URL="<الرابط>" npm run migrate
   ```
   الترحيل `0037` يفعّل RLS على كل الجداول فلا تُكشف عبر واجهة Supabase العامة؛ الباك إند يتصل بدور المالك فلا يتأثر.
4. SSL تلقائي لأي مضيف غير محلي. للتحقق الصارم من هوية الخادم ضع شهادة CA في `DATABASE_SSL_CA`.

## 2) الباك إند على Vercel (مشروع جديد، Root Directory = `backend`)
متغيرات البيئة (Settings → Environment Variables):
`DATABASE_URL` · `DB_POOL_MAX=1` · `JWT_ACCESS_SECRET` · `JWT_REFRESH_SECRET` (`openssl rand -hex 32` لكل منهما) · `LICENSE_REQUIRED=1` (اختياري: يرفض من لا ترخيص له) · `BOOTSTRAP_SECRET` (**إلزامي في الإنتاج وإلا يُغلق إنشاء المستأجرين**) · `CORS_ORIGINS` (نطاق الواجهة، مثل `https://app.example.com`) · `DEVELOPER_SECRET` (كلمة مرور لوحة المطور، 12+ حرفًا) · اختياريًا `UPDATE_FEED_URL`.
بعد النشر: `https://<backend>.vercel.app/health` يجب أن يُرجع `{"status":"ok"}`.

**بديل Render:** New → Blueprint → المستودع (يقرأ `backend/render.yaml`)، والصق `DATABASE_URL`. الخدمة "تنام" بعد 15 دقيقة (أول طلب ~30 ثانية؛ مؤشر "السحابة" في الواجهة يعرض "الخادم يستيقظ").

## 3) الواجهة على Vercel (Root Directory = `frontend`)
متغير واحد: `VITE_API_BASE_URL=https://<backend>.vercel.app/api` (بلا شرطة أخيرة). ثم عدّل `frontend/public/brand.json` لهوية العميل.

## 4) أول عميل
```bash
curl -X POST https://<backend>/api/bootstrap -H "Content-Type: application/json" -H "x-bootstrap-secret: <BOOTSTRAP_SECRET>" \
  -d '{"tenantName":"..","companyLegalName":"..","ownerEmail":"..","ownerPassword":".."}'
```
## 5) لوحة المطور
مشروع Vercel ثالث بـ Root Directory = `developer-panel`؛ عدّل `developer-panel/config.js` → `apiBase` إلى عنوان الباك إند. التفاصيل في [DEVELOPER-PANEL.md](DEVELOPER-PANEL.md).

## قيود واقعية — اقرأها قبل البيع
- **شروط Vercel Hobby (المجانية) للاستخدام غير التجاري فقط.** تشغيل عملاء يدفعون لك تجاريًا يتطلب خطة Pro، أو بديلًا مجانيًا يسمح بالاستخدام التجاري: **Netlify** للواجهة (`netlify.toml` جاهز) و**Render/Cloudflare Pages**. راجع شروط كل مزوّد الحالية.
- **Supabase المجاني** يوقف المشروع بعد ~أسبوع بلا نشاط ويحدد التخزين (~500MB) ولا يتضمن نسخًا احتياطية يومية — صدّر نسخة دورية (`pg_dump`) لأي عميل حقيقي.
- **حجم الطلب على Vercel Functions ~4.5MB** بينما حد المرفقات في النواة 5MB؛ المرفقات بين 4.5 و5MB تفشل على Vercel (تعمل على Render).
- الدالة تنتهي عند 30 ثانية (مضبوطة)، والتقارير الضخمة قد تحتاج استضافة دائمة.
- **لا تنسَ:** ضع `BOOTSTRAP_SECRET` و`DEVELOPER_SECRET` وأسرار JWT قوية؛ لا تضعها في المستودع.

## تمرين الاستعادة (افعله قبل تسليم أي عميل ثم شهريًا)
النسخة التي لم تُستعَد لا يُعتمد عليها. أنشئ قاعدة فارغة منفصلة (مشروع Supabase مجاني ثانٍ يكفي) ثم:
```bash
bash tools/restore-backup.sh <نسخة.dump.gpg> "<القاعدة الفارغة>" --wipe
```
يعمل pg_dump ثم pg_restore ويقارن عدد صفوف كل جدول؛ كود الخروج 0 = سليم. يرفض التنفيذ إن تطابق العنوانان. **SCRATCH_URL تُمحى محتوياتها.**

## نموذج «العميل يأخذ رابطًا فقط»
تنشر أنت الخادم والواجهة ولوحة المطور مرة واحدة، وتنشئ كل عميل من لوحة المطور (قسم «العملاء») وترسل له رابطه. راجع [WHITE-LABEL.md](WHITE-LABEL.md). نسخة سطح المكتب (exe) لا تناسب هذا النموذج: كودها مضمَّن داخلها ولا تتصل بلوحتك فلا يمكن إيقافها ولا ترخيصها.


## استضافة مجانية خاصة بكل عميل (مرحلة ما قبل الاستضافة المدفوعة)
لكل عميل نسخة مستقلة بحسابات خاصة به، فلا يتشارك عميلان قاعدة بيانات ولا مفاتيح:
1. أنشئ بريدًا خاصًا بالعميل (مثلًا `client1.erp@gmail.com`) وسجّل به في **Supabase** (قاعدة البيانات + التخزين) و**Vercel/Render** (الواجهة والخادم).
2. أنشئ مشروع Supabase جديدًا وطبّق الترحيلات (`MIGRATION-SUPABASE.md`) واضبط `DATABASE_URL`, `JWT_*`, `BOOTSTRAP_SECRET`, `CORS_ORIGINS`.
3. انشر الواجهة بنفس الكود مع `public/brand.json` الخاص بالعميل ثم أنشئ الشركة والمالك عبر `/bootstrap` ثم أنشئ بقية المستخدمين من «المستخدمون والصلاحيات».
4. سلّم العميل الرابط فقط. الكود يبقى عندك.

**تنبيهات صادقة:** (أ) Vercel Hobby للاستخدام غير التجاري؛ التشغيل لعميل يدفع لك يخالف شروطها، فاعتبره مرحلة تجريبية قصيرة. (ب) Supabase المجاني يُوقف المشروع بعد نحو أسبوع بلا نشاط ولا نسخ يومية؛ نفّذ `tools/restore-backup.sh` (أو الـworkflow الشهري restore-drill.yml) دوريًا وانقل العميل للمدفوع قبل البيانات الحقيقية الكثيفة. (ج) عند التحوّل للمدفوع انقل قاعدة العميل بـ pg_dump/restore دون تغيير الكود.
