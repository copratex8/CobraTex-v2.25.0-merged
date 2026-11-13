# تغليف CobraTex كملف exe (Windows)

الغلاف في `desktop-offline/` (Electron + electron-builder). الملف الناتج **شامل**: Node/Chromium + كل مكتبات الباك إند
(express, pg, zod, jsonwebtoken…) + PostgreSQL مضمَّن (`embedded-postgres`) + الواجهة المبنية. لا يحتاج الجهاز أي تثبيت.
تكامل Google Drive جزء من الباك إند نفسه (fetch) فيدخل الملف تلقائيًا.

## البناء (على ويندوز، Node 22+)
```
cd desktop
build-exe.bat            :: أو: npm install && npm run dist
```
النتيجة في `desktop-offline/release/`: `CobraTex-1.2.0-x64-nsis.exe` (مثبّت) و`...-portable.exe` (بلا تثبيت).
بديل بلا ويندوز: شغّل مسار GitHub Actions «Build Windows EXE» (`.github/workflows/build-exe.yml`) ونزّل الناتج من Artifacts.

## ماذا يحدث عند التشغيل
1. أول مرة: تُنشأ مفاتيح عشوائية وقاعدة PostgreSQL محلية في `%APPDATA%\CobraTex\data`.
2. تُطبَّق الهجرات تلقائيًا (كل تحديث يطبّق الجديد منها فقط).
3. يفتح خادم داخلي على `http://localhost:47600` (محلي فقط، غير مكشوف للشبكة) وتظهر شاشة إنشاء الشركة والمالك مرة واحدة.
4. النسخ الاحتياطية في `%APPDATA%\CobraTex\backups`.

## الإعدادات (`%APPDATA%\CobraTex\data\config.json`)
- `port`: المنفذ (إن تغيّر غيّر redirect URI في Google أيضًا).
- `databaseUrl`: لاستخدام قاعدة خارجية (مثل Supabase) بدل المضمَّنة.

## أخطاء شائعة
| العرض | الحل |
|---|---|
| «المنفذ مستخدم» | غيّر `port` في config.json |
| لا يقلع | راجع `%APPDATA%\CobraTex\cobratex.log` |
| SmartScreen يحذّر | الملف غير موقّع رقميًا؛ لإزالة التحذير وقّعه بشهادة Code Signing (`win.certificateFile` في package.json) |

## حدود معروفة
- لم يُبنَ الـexe في بيئة التطوير (لا يوجد ويندوز ولا وصول لـnpm)؛ أول بناء عندك أو في GitHub Actions هو الاختبار الحقيقي.
- التحديث التلقائي للـexe غير مُفعَّل بعد (التحديث بتثبيت الإصدار الجديد فوق القديم؛ البيانات محفوظة في AppData).
