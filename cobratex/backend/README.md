# G-Tech ERP — Backend Core

## المتطلبات
- Node.js 20+
- PostgreSQL 16 (محلي أو أي مزود يدعم Deferred Constraint Triggers القياسية)

## التشغيل محليًا
```bash
cp .env.example .env      # عدّل DATABASE_URL/JWT secrets
npm install
npm run migrate           # يطبّق كل ملفات src/db/migrations/*.sql بالترتيب
npm run dev                # يشغّل الخادم على PORT (افتراضي 4000)
```

## الاختبارات
```bash
createdb gtech_erp_test    # أو أي قاعدة بيانات فارغة مخصصة للاختبار
cp .env.example .env.test  # واضبط DATABASE_URL على gtech_erp_test
DATABASE_URL=... npm run migrate   # طبّق المخطط على قاعدة الاختبار أيضًا
npm run test
```

## ملاحظة: لماذا لا يوجد Prisma هنا رغم أنه الخيار الموثّق في ARCHITECTURE.md؟
محرك Prisma (schema-engine) يُنزَّل من `binaries.prisma.sh` عند أول استخدام، وهذا النطاق غير
متاح في شبكة بيئة التطوير التي بُني بها هذا الكود. لذلك استُخدم بديل يعمل بالكامل عبر حزم npm
عادية: `pg` (اتصال) + migrations خام بصيغة SQL مُرقَّمة + مُشغِّل بسيط (`src/db/migrate.ts`).
هذا ليس فقط حلاً بديلاً للمشكلة الشبكية، بل ضروري أساسًا لأن الميزات الحرجة في هذه المرحلة
(Deferred Constraint Trigger، الفهارس الجزئية، القيود المركّبة) لا يمكن التعبير عنها بلغة
Prisma Schema أصلًا وتحتاج SQL خام بغض النظر عن اختيار الـ ORM. في بيئة إنتاج تصل فيها الشبكة
لموقع Prisma، يمكن تبني `prisma migrate deploy` لاحقًا كطبقة فوق نفس ملفات SQL دون تغييرها.

راجع `../docs/DECISIONS.md` لتفاصيل هذا القرار وغيره.
