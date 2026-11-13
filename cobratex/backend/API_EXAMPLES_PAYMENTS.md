## فاتورة بقيمة 1000 (10×100)، دفعة جزئية 600 مخصَّصة لها
### GET remaining-balance قبل الدفع
{"total":"1000.0000","allocated":"0.0000","remaining":"1000.0000"}
HTTP_STATUS:200
-e 
### POST /sales/payments — دفعة 600 مخصَّصة جزئيًا (نجاح)
HTTP_STATUS:201
{"id":"9159de34-41d5-4623-aada-99db30c7059f","company_id":"e7ad09e9-7ef7-4074-bc00-aa40c8c33c56","branch_id":"bb0fdd16-d9d5-4e04-a801-b9a553fd78e3","customer_id":"bca20f93-8c58-4d92-813c-0d1a00ae528c","fiscal_period_id":"a6b61db9-6497-44b4-abfd-df61870ead48","document_number":"RCPT-000001","currency_code":"EGP","exchange_rate":"1.000000","payment_date":"2026-02-10T00:00:00.000Z","amount":"600.0000","receipt_account_id":"a78fe757-fad7-433a-b449-ff0a89fbf1fc","status":"draft","journal_entry_id":null,"reversal_of_payment_id":null,"cancelled_reason":null,"cancelled_by":null,"cancelled_at":null,"created_by":"90017faa-e6aa-411d-9c04-3a3d2fe4edbc","posted_by":null,"posted_at":null,"created_at":"2026-08-22T15:58:29.604Z"}-e 
### POST /sales/payments/:id/post — ترحيل الدفعة (نجاح)
{"id":"9159de34-41d5-4623-aada-99db30c7059f","journalEntryId":"19be86a6-5fa3-4efd-ba14-5b96cc61e3fa"}
HTTP_STATUS:200
-e 
### GET remaining-balance بعد الدفع الجزئي (يجب أن يظهر 400 متبقٍ)
{"total":"1000.0000","allocated":"600.0000","remaining":"400.0000"}
HTTP_STATUS:200
-e 
### محاولة دفعة ثانية بمبلغ 500 (يتجاوز الـ 400 المتبقي) — فشل متوقع
{"error":"مبلغ التخصيص (500.0000) يتجاوز المتبقي غير المُحصَّل من الفاتورة (400.0000)"}
HTTP_STATUS:422
