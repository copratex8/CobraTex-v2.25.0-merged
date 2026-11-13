# أمثلة API — مرحلة سد الفجوات (PostingRule, RBAC, دورة حياة القيد, العكس)
كل الأمثلة نتائج فعلية من تشغيل حي للخادم (`npm run dev`) مقابل PostgreSQL محلية.

## PostingRule — قواعد ناقصة/متعارضة مرفوضة بوضوح
```
POST /api/accounting/posting-rules  {operationType:"sales_invoice_revenue", debitAccountSourceType:"FIXED_ACCOUNT" /* بلا معرّف حساب */, ...}
→ HTTP 422 {"error":"قاعدة ترحيل ناقصة: FIXED_ACCOUNT للمدين يتطلب debitFixedAccountId"}

POST /api/accounting/posting-rules  {operationType:"sales_invoice_revenue", debitFixedAccountId:<Cash>, creditFixedAccountId:<Revenue>}
→ HTTP 201 {id, operation_type:"sales_invoice_revenue", is_active:true, ...}

POST /api/accounting/posting-rules  (نفس operationType مرة أخرى)
→ HTTP 409 {"error":"توجد بالفعل قاعدة ترحيل نشطة متعارضة للعملية: sales_invoice_revenue"}
```

## معاينة قيد بيع من رِجلين (بلا كتابة في قاعدة البيانات)
```
POST /api/accounting/posting-preview
{"legs":[
  {"operationType":"sales_invoice_revenue","amount":"900"},
  {"operationType":"sales_invoice_cogs","amount":"540","itemCategoryId":"<فئة الأقمشة>"}
]}
→ HTTP 200
{
  "lines": [
    {"accountId":"<Cash>","debit":"900.0000","credit":"0"},
    {"accountId":"<Revenue>","debit":"0","credit":"900.0000"},
    {"accountId":"<COGS>","debit":"540.0000","credit":"0"},
    {"accountId":"<Inventory>","debit":"0","credit":"540.0000"}
  ],
  "totalDebit": "1440.0000", "totalCredit": "1440.0000", "isBalanced": true
}
```
لاحظ: حسابا المخزون/تكلفة المبيعات استُخرجا تلقائيًا من `default_inventory_account_id`/`default_cogs_account_id`
على فئة الصنف (`ITEM_CATEGORY_INVENTORY`/`ITEM_CATEGORY_COGS`)، لا بإدخال يدوي.

## دورة حياة القيد — لا قفز، لا تعديل بعد الترحيل، عكس موثّق
```
POST /api/accounting/journal-entries/draft {...} → HTTP 201 {"id":"E1"}

POST /api/accounting/journal-entries/E1/transition {"target":"posted"}   ← من draft مباشرة
→ HTTP 422 {"error":"انتقال حالة غير مسموح: draft → posted"}

POST .../E1/transition {"target":"pending_review"} → 200 {"status":"pending_review"}
POST .../E1/transition {"target":"approved"}       → 200 {"status":"approved"}
POST .../E1/transition {"target":"posted"}         → 200 {"status":"posted"}

POST /api/accounting/journal-entries/E1/reverse {"reason":"تصحيح خطأ في القيد اليدوي"}
→ HTTP 201 {"originalEntryId":"E1","reversalEntryId":"E2"}

POST /api/accounting/journal-entries/E1/reverse {"reason":"محاولة ثانية"}   ← E1 لم يعد posted (أصبح reversed)
→ HTTP 422 {"error":"لا يمكن عكس قيد بحالة reversed؛ يجب أن يكون مرحّلًا (posted)"}
```

## RBAC — 401/403/نجاح (من تشغيل الاختبارات الآلية الفعلي، نفس السلوك عبر curl)
```
POST /api/items (بلا توكن)                          → 401 {"error":"التوكن مفقود"}
POST /api/items (توكن مستخدم بلا items.item.create)  → 403 {"error":"ليس لدى المستخدم صلاحية: items.item.create"}
POST /api/accounting/journal-entries
  (مستخدم يملك accounting.journal.create فقط، بلا submit/approve/post)
→ 403 {"error":"ليس لدى المستخدم صلاحية: accounting.journal.submit"}

POST /api/inventory/movements/in
  (مستخدم بصلاحية inventory.movement.post بنطاق own_branch، على فرعه الخاص) → 201
  (نفس المستخدم، على فرع آخر بنفس الشركة)                                    → 403
```
