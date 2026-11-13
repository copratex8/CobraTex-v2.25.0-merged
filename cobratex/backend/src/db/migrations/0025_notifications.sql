-- 0025_notifications.sql
-- المرحلة: مركز إشعارات داخل النظام + إشعارات فورية عن بُعد للمتصفح (Web Push) — قناة مجانية
-- بالكامل (بروتوكول Web Push القياسي عبر مفاتيح VAPID ذاتية التوليد، بلا أي خدمة طرف ثالث مدفوعة
-- مثل Firebase/OneSignal). راجع تقرير هذه المرحلة للتفصيل.

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  user_id UUID NOT NULL,
  type TEXT NOT NULL, -- مثل: sales_invoice_posted, customer_payment_posted... حرّ التسمية لأي منطق مُستقبلي (بما فيه الإضافات)
  title TEXT NOT NULL,
  body TEXT,
  source_document_type TEXT,
  source_document_id UUID,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id, read_at) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at DESC);

-- اشتراك Web Push لكل مستخدم/جهاز (متصفح واحد = اشتراك واحد؛ نفس المستخدم على أكثر من جهاز = عدة صفوف)
CREATE TABLE push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  user_id UUID NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

INSERT INTO permissions(code) VALUES
  ('notifications.view'), ('notifications.push_subscription.manage')
ON CONFLICT (code) DO NOTHING;
