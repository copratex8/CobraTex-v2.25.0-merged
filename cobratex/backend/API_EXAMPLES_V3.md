## 2) إعداد: حسابات + فترة مالية + فئة صنف + صنف + مورد+عميل + ضريبة + قواعد ترحيل
TAX_HTTP:201
{"id":"e7b01ee7-bcc3-45fb-a6fd-11bc681daa26","company_id":"561ef034-550e-4ddf-a2c2-ec84e58c72c4","operation_type":"sales_invoice_revenue","debit_account_source_type":"CUSTOMER_RECEIVABLE","debit_fixed_account_id":null,"credit_account_source_type":"FIXED_ACCOUNT","credit_fixed_account_id":"0f97e633-1115-4e63-a081-cdf54bd90807","is_active":true,"created_at":"2026-08-22T05:57:29.770Z"}
RULE1_HTTP:201
{"id":"2f6ce5fa-5091-41f4-9382-6a2d023384f6","company_id":"561ef034-550e-4ddf-a2c2-ec84e58c72c4","operation_type":"sales_invoice_tax","debit_account_source_type":"CUSTOMER_RECEIVABLE","debit_fixed_account_id":null,"credit_account_source_type":"FIXED_ACCOUNT","credit_fixed_account_id":"79825e75-358f-451a-94fd-28cc9224985d","is_active":true,"created_at":"2026-08-22T05:57:29.778Z"}
RULE2_HTTP:201
{"id":"fd1feb0e-031d-4f83-a549-6ffbfb0aa63a","company_id":"561ef034-550e-4ddf-a2c2-ec84e58c72c4","operation_type":"sales_invoice_cogs","debit_account_source_type":"ITEM_CATEGORY_COGS","debit_fixed_account_id":null,"credit_account_source_type":"ITEM_CATEGORY_INVENTORY","credit_fixed_account_id":null,"is_active":true,"created_at":"2026-08-22T05:57:29.785Z"}
RULE3_HTTP:201
{"movementId":"458d2bf2-9f0c-4f5c-9ced-3a18cdba04b1","newWeightedAverageCost":"30.0000"}
OPENING_HTTP:201
## 3) POST /api/sales/invoices — إنشاء فاتورة (30 وحدة، سعر 50، ضريبة 14%) — نجاح، بلا أثر بعد
HTTP_STATUS:201
{"id":"fb6970a7-c23b-4c8c-98d8-db18e3ed43c9","company_id":"561ef034-550e-4ddf-a2c2-ec84e58c72c4","branch_id":"c2bdb56a-c008-4159-b88c-91c96968a180","warehouse_id":"584a34d3-a1f8-4857-9144-d078b8b53013","customer_id":"d45bc147-c6f1-4520-9afe-d00899261141","sales_order_id":null,"fiscal_period_id":"17cd163f-eb61-48a8-9311-29c95669fa62","document_number":"SINV-000001","currency_code":"EGP","exchange_rate":"1.000000","invoice_date":"2026-02-01T00:00:00.000Z","status":"draft","journal_entry_id":null,"reversal_of_invoice_id":null,"cancelled_reason":null,"cancelled_by":null,"cancelled_at":null,"created_by":"d99dd24b-9b78-44fc-8264-54110900d16d","posted_by":null,"posted_at":null,"created_at":"2026-08-22T05:57:53.700Z"}-e 
## 4) POST /sales/invoices/:id/post — الترحيل (نجاح: قيد رباعي + صرف مخزون بالمتوسط المرجح)
{"id":"fb6970a7-c23b-4c8c-98d8-db18e3ed43c9","journalEntryId":"ba68f9b4-42d5-4abc-a2d4-c83b72686802","totalRevenue":"1500.0000","totalTax":"210.0000"}
HTTP_STATUS:200
-e 
## 5) GET /inventory/balance بعد الترحيل (نجاح: 200-30=170)
{"id":"c624b1c6-8027-4816-8cb4-bb3e20325f1a","company_id":"561ef034-550e-4ddf-a2c2-ec84e58c72c4","warehouse_id":"584a34d3-a1f8-4857-9144-d078b8b53013","item_id":"adc24d19-0e7e-4104-af15-ffededf61203","batch_id":null,"quantity_on_hand":"170.0000","quantity_reserved":"0.0000","weighted_average_cost":"30.0000","last_recalculated_at":"2026-08-22T05:57:53.752Z"}
HTTP_STATUS:200
-e 
## 6) محاولة ترحيل نفس الفاتورة مرة أخرى (فشل متوقع: ليست draft)
{"error":"لا يمكن ترحيل فاتورة بحالة posted؛ يجب أن تكون draft"}
HTTP_STATUS:422
-e 
## 7) POST /accounting/tax-types/:id/change-rate — تغيير النسبة إلى 15% اعتبارًا من 2026-07-01 (نجاح)
{"id":"9fac11e5-db04-4b8e-af80-46427b4591bf","tax_type_id":"88425f57-1eae-4d7e-8568-035999820ab8","company_id":"561ef034-550e-4ddf-a2c2-ec84e58c72c4","rate_percent":"15.000","is_price_inclusive":false,"is_exempt":false,"rounding_mode":"half_even","effective_from":"2026-07-01T00:00:00.000Z","effective_to":null,"created_by":"d99dd24b-9b78-44fc-8264-54110900d16d","created_at":"2026-08-22T05:57:53.805Z"}
HTTP_STATUS:201
-e 
## 8) فاتورة جديدة بتاريخ فبراير — يجب أن تستخدم 14% القديمة رغم تغيير النسبة (نجاح)
HTTP_STATUS:201
subtotal/tax lookup will show at posting; invoice id: 36d60781-2637-4997-b7b4-0c6c8b6fb7f4
-e 
## 9) POST /sales/invoices/:id/reverse — عكس الفاتورة الأولى (نجاح، سبب إلزامي)
{"id":"fb6970a7-c23b-4c8c-98d8-db18e3ed43c9","status":"reversed"}
HTTP_STATUS:200
-e 
## 10) GET /inventory/balance بعد العكس (نجاح: يعود 170+30=200)
{"id":"c624b1c6-8027-4816-8cb4-bb3e20325f1a","company_id":"561ef034-550e-4ddf-a2c2-ec84e58c72c4","warehouse_id":"584a34d3-a1f8-4857-9144-d078b8b53013","item_id":"adc24d19-0e7e-4104-af15-ffededf61203","batch_id":null,"quantity_on_hand":"200.0000","quantity_reserved":"0.0000","weighted_average_cost":"30.0000","last_recalculated_at":"2026-08-22T05:57:53.850Z"}
HTTP_STATUS:200
