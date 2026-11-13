## 2) إنشاء حسابات وفترة مالية وفئة صنف بحسابات افتراضية
HTTP_STATUS:201
HTTP_STATUS:201
HTTP_STATUS:201
HTTP_STATUS:201
HTTP_STATUS:201
-e 
## 3) POST /api/accounting/posting-rules — قاعدة ناقصة (فشل متوقع)
{"error":"قاعدة ترحيل ناقصة: FIXED_ACCOUNT للمدين يتطلب debitFixedAccountId"}
HTTP_STATUS:422
-e 
## 4) POST /api/accounting/posting-rules — قاعدتا بيع صحيحتان (نجاح)
{"id":"ff1770f1-98ff-4957-a71f-4f630dd6ad22","company_id":"b3cae4a9-2194-4b76-ace8-1b82c091378e","operation_type":"sales_invoice_revenue","debit_account_source_type":"FIXED_ACCOUNT","debit_fixed_account_id":"dca012c8-3896-41e6-8e0d-02ef7cd87d65","credit_account_source_type":"FIXED_ACCOUNT","credit_fixed_account_id":"4e6ac64a-6bd0-48a8-bc39-9eb0799e84d1","is_active":true,"created_at":"2026-08-19T18:20:46.571Z"}
HTTP_STATUS:201
{"id":"9d8d8a1c-3139-4021-bad6-0ccf7f6cda14","company_id":"b3cae4a9-2194-4b76-ace8-1b82c091378e","operation_type":"sales_invoice_cogs","debit_account_source_type":"ITEM_CATEGORY_COGS","debit_fixed_account_id":null,"credit_account_source_type":"ITEM_CATEGORY_INVENTORY","credit_fixed_account_id":null,"is_active":true,"created_at":"2026-08-19T18:20:46.581Z"}
HTTP_STATUS:201
-e 
## 5) POST /api/accounting/posting-rules — نفس sales_invoice_revenue مرة أخرى (فشل متوقع: تعارض)
{"error":"توجد بالفعل قاعدة ترحيل نشطة متعارضة للعملية: sales_invoice_revenue"}
HTTP_STATUS:409
## 6) إنشاء فئة صنف بحسابات مخزون/تكلفة افتراضية، ثم معاينة قيد بيع (رِجلين، نجاح)
HTTP_STATUS:201
{"id":"50ee2832-8079-4d6e-a46a-470e9ebb41d5","company_id":"b3cae4a9-2194-4b76-ace8-1b82c091378e","activity_id":null,"name_ar":"أقمشة","name_en":"Fabrics","item_kind":"fabric","parent_id":null,"default_inventory_account_id":"bf401819-b17b-4d6c-aae9-db9a76291909","default_cogs_account_id":"b6070c7d-899d-43f4-b5fe-b0971a2360a3"}-e 
## 7) POST /api/accounting/posting-preview — معاينة قيد بيع (بلا كتابة في قاعدة البيانات)
{"lines":[{"accountId":"dca012c8-3896-41e6-8e0d-02ef7cd87d65","debit":"900.0000","credit":"0","description":"sales_invoice_revenue"},{"accountId":"4e6ac64a-6bd0-48a8-bc39-9eb0799e84d1","debit":"0","credit":"900.0000","description":"sales_invoice_revenue"},{"accountId":"b6070c7d-899d-43f4-b5fe-b0971a2360a3","debit":"540.0000","credit":"0","description":"sales_invoice_cogs"},{"accountId":"bf401819-b17b-4d6c-aae9-db9a76291909","debit":"0","credit":"540.0000","description":"sales_invoice_cogs"}],"totalDebit":"1440.0000","totalCredit":"1440.0000","isBalanced":true}
HTTP_STATUS:200
-e 
## 8) POST /api/accounting/journal-entries/draft — إنشاء قيد مسودة (نجاح)
HTTP_STATUS:201
{"id":"dfe8bd20-79ef-40e1-8be2-48d0af3f607d"}-e 
## 9) POST .../transition target=posted مباشرة من draft (فشل متوقع: قفز غير مسموح)
{"error":"انتقال حالة غير مسموح: draft → posted"}
HTTP_STATUS:422
-e 
## 10) التسلسل الصحيح: pending_review ثم approved ثم posted (نجاح)
{"id":"dfe8bd20-79ef-40e1-8be2-48d0af3f607d","status":"pending_review"}HTTP_STATUS:200
{"id":"dfe8bd20-79ef-40e1-8be2-48d0af3f607d","status":"approved"}HTTP_STATUS:200
{"id":"dfe8bd20-79ef-40e1-8be2-48d0af3f607d","status":"posted"}HTTP_STATUS:200
-e 
## 11) POST .../reverse — عكس القيد المرحّل (نجاح)
{"originalEntryId":"dfe8bd20-79ef-40e1-8be2-48d0af3f607d","reversalEntryId":"9d2820ee-4866-49e1-8d1c-55d7a0aa1fc1"}
HTTP_STATUS:201
-e 
## 12) محاولة عكس نفس القيد مرة أخرى (فشل متوقع: لم يعد posted)
{"error":"لا يمكن عكس قيد بحالة reversed؛ يجب أن يكون مرحّلًا (posted)"}
HTTP_STATUS:422
