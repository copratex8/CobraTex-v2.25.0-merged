-- 0027_refresh_tokens.sql
-- فجوة موثَّقة كانت في AuthContext.tsx/client.ts بالواجهة: لا Refresh Token إطلاقًا، الجلسة تنتهي
-- بعد 15 دقيقة (accessTokenTtl) وتتطلب دخولًا جديدًا. نخزّن هاش SHA-256 فقط لكل refresh token
-- (لا التوكن الخام) — تمامًا كخزن كلمات المرور، حتى لو تسرَّبت قاعدة البيانات لا يمكن استخدام
-- الصفوف مباشرة كتوكنات صالحة. revoked_at يُستخدَم لإبطال فوري عند تسجيل الخروج أو عند اكتشاف
-- إعادة استخدام توكن مُدار (rotation reuse detection) في identityService.refreshSession.
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by_id UUID REFERENCES refresh_tokens(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
