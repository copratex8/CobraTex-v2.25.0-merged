# أمثلة فعلية لطلبات API — Backend Core
كل الأمثلة أدناه نتائج حقيقية من تشغيل فعلي للخادم (`npm run dev`) مقابل قاعدة بيانات PostgreSQL محلية، وليست نصوصًا افتراضية.

## 1) POST /api/bootstrap — الإعداد الأول (نجاح)
```
HTTP 201
{
  "tenantId": "7af7e5ad-432d-44ec-8fa8-ab8a56c6eef1",
  "companyId": "0d9bc20e-8adc-4385-a3ad-2f11cbe3439b",
  "branchId": "350ead9b-78fa-4473-9732-5caded92016a",
  "warehouseId": "e36eb3e9-8ce0-4776-a44e-761d1241d71d",
  "ownerUserId": "0f35cfb5-b797-4aed-8789-7f3b21083658",
  "accessToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

## 2) POST /api/uoms — إنشاء وحدة قياس (نجاح، محمي بتوكن)
```
HTTP 201
{"id":"041c3596-...","company_id":"0d9bc20e-...","name_ar":"متر","name_en":"Meter","symbol":"m"}
```

## 3) POST /api/items — إنشاء صنف نوعه "قماش" (نجاح — يوضح الوحدة الموحّدة بديلة TechTex الثلاثية)
```
HTTP 201
{
  "id": "0751a679-85fb-41bb-abbd-d91583b3d534",
  "item_kind": "fabric",
  "code": "FAB-001",
  "name_ar": "قماش قطن أبيض",
  "name_en": "White Cotton Fabric",
  "reorder_point": "0.0000",
  "custom_fields": {},
  "is_active": true
}
```

## 4) POST /api/items — كود صنف مكرر داخل نفس الشركة (فشل متوقع — قيد Unique)
```
HTTP 409
{"error":"كود الصنف أو الباركود مستخدم بالفعل داخل هذه الشركة"}
```

## 5) POST /api/inventory/movements/in — وارد 100 وحدة بتكلفة 25.50 (نجاح)
```
HTTP 201
{"movementId":"7a95715d-5bfc-4288-82bd-f4fb2ec18441"}
```

## 6) GET /api/inventory/balance — الرصيد بعد الوارد (نجاح)
```
HTTP 200
{
  "quantity_on_hand": "100.0000",
  "quantity_reserved": "0.0000",
  "weighted_average_cost": "25.5000"
}
```

## 7) POST /api/inventory/movements/out — صرف كمية تفوق المتاح (فشل متوقع)
```
HTTP 422
{"error":"الكمية المتاحة غير كافية: المطلوب 9999.0000 والمتاح 100.0000"}
```

## 8) POST /api/inventory/movements/out — صرف 30 وحدة صحيحة (نجاح — تكلفة FIFO محسوبة تلقائيًا)
```
HTTP 201
{"movementId":"6a9b57f5-...","costOfGoodsConsumed":"765.0000"}
```
> 30 وحدة × 25.50 = 765.0000 بالضبط — يثبت دقة Decimal بلا انحراف تقريب.

## 9) POST /api/accounting/accounts و /fiscal-periods (نجاح)
```
HTTP 201  {"code":"1000","name_ar":"النقدية","account_type":"asset", ...}
HTTP 201  {"code":"4000","name_ar":"الإيرادات","account_type":"revenue", ...}
HTTP 201  {"start_date":"2026-01-01","end_date":"2026-12-31","status":"open"}
```

## 10) POST /api/accounting/journal-entries — قيد غير متوازن عمدًا (فشل متوقع — تحقق طبقة التطبيق)
```
Request lines: [{debit:765.00, credit:0}, {debit:0, credit:700.00}]
HTTP 422
{"error":"القيد غير متوازن: إجمالي المدين 765.0000 لا يساوي إجمالي الدائن 700.0000"}
```
لاحظ: هذا الرفض حدث **قبل** أي INSERT في قاعدة البيانات (تحقق تطبيقي مبكر)، وطبقة الحماية
الثانية (Deferred Trigger) موثّقة ومُختبرة بشكل منفصل في `tests/journalBalance.test.ts` عبر
مسار يتجاوز هذا التحقق عمدًا لإثبات أن قاعدة البيانات نفسها ترفض أيضًا.

## 11) POST /api/accounting/journal-entries — قيد متوازن صحيح، مرتبط بمستند الصرف رقم 8 (نجاح)
```
HTTP 201
{"id":"c9fccc41-c6ec-4820-98a6-3f938fe4cda7","totalDebit":"765.0000","totalCredit":"765.0000"}
```

## 12) GET /api/items/:id بدون توكن (فشل متوقع — 401)
```
HTTP 401
{"error":"التوكن مفقود"}
```

---
**الخلاصة من هذه السلسلة الفعلية:** 30 وحدة × 25.50 جنيه = 765.0000 جنيه بالضبط ظهرت في ثلاثة أماكن
مستقلة ومتسقة: تكلفة البضاعة المصروفة من محرك FIFO (الخطوة 8)، ثم كمبلغ القيد المحاسبي المرتبط بنفس
العملية (الخطوة 11) — وهذا مثال حي وليس افتراضيًا على مبدأ التتبع من المستند إلى الحركة إلى القيد
المطلوب في DATA_MODEL.md §8.
