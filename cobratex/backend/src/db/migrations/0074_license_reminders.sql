-- 0074_license_reminders.sql — تذكيرات تلقائية بانتهاء الترخيص (دُمجت من «التحكم عن بُعد» في نسخة cobratex-ready فوق نظام التراخيص 0071).
-- مصدر الحقيقة الوحيد للاشتراك = tenant_licenses (expires_at + grace_days)؛ لا جدول اشتراكات مكرَّر.
-- العتبات: قبل 14/7/3/1 يوم وفي يوم الانتهاء، ثم يوميًا طوال فترة السماح. مرة واحدة لكل عتبة.

CREATE TABLE IF NOT EXISTS license_reminders_sent (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_on DATE NOT NULL,
  threshold INT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, expires_on, threshold)
);
ALTER TABLE license_reminders_sent ENABLE ROW LEVEL SECURITY;

-- «اليوم» بتوقيت العميل (افتراضي القاهرة؛ غيّره بصف platform_settings: key='timezone', value={"tz":"Asia/Riyadh"})
CREATE OR REPLACE FUNCTION platform_today() RETURNS DATE
LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE COALESCE((SELECT value ->> 'tz' FROM platform_settings WHERE key = 'timezone'), 'Africa/Cairo'))::date
$$;

-- none | active | expiring (<=14 يومًا) | grace | expired. الترخيص الدائم (expires_at NULL) = active دائمًا.
CREATE OR REPLACE FUNCTION license_state(p_tenant UUID)
RETURNS TABLE(state TEXT, days_left INT, expires_on DATE, grace_until DATE, plan TEXT)
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN l.tenant_id IS NULL THEN 'none'
           WHEN l.expires_at IS NULL THEN 'active'
           WHEN platform_today() > (l.expires_at AT TIME ZONE 'UTC')::date + l.grace_days THEN 'expired'
           WHEN platform_today() > (l.expires_at AT TIME ZONE 'UTC')::date THEN 'grace'
           WHEN (l.expires_at AT TIME ZONE 'UTC')::date - platform_today() <= 14 THEN 'expiring'
           ELSE 'active'
         END,
         CASE WHEN l.expires_at IS NULL THEN NULL ELSE ((l.expires_at AT TIME ZONE 'UTC')::date - platform_today())::int END,
         (l.expires_at AT TIME ZONE 'UTC')::date,
         (l.expires_at AT TIME ZONE 'UTC')::date + l.grace_days,
         l.plan_type
  FROM (SELECT p_tenant AS id) x
  LEFT JOIN tenant_licenses l ON l.tenant_id = x.id
$$;

-- هل يجب حجب القراءة على مستوى RLS/Realtime؟ فقط للتراخيص ذات الوضع «block» بعد انتهاء فترة السماح.
CREATE OR REPLACE FUNCTION license_blocks(p_tenant UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM tenant_licenses l
     WHERE l.tenant_id = p_tenant AND l.expires_at IS NOT NULL AND l.expired_mode = 'block'
       AND platform_today() > (l.expires_at AT TIME ZONE 'UTC')::date + l.grace_days
  )
$$;

CREATE OR REPLACE FUNCTION send_license_reminders()
RETURNS TABLE(out_user_id UUID, out_title TEXT, out_body TEXT)
LANGUAGE plpgsql AS $$
DECLARE
  r RECORD;
  t TEXT;
  b TEXT;
BEGIN
  FOR r IN
    SELECT l.tenant_id, (l.expires_at AT TIME ZONE 'UTC')::date AS exp, l.grace_days,
           ((l.expires_at AT TIME ZONE 'UTC')::date - platform_today())::int AS dl
      FROM tenant_licenses l
     WHERE l.expires_at IS NOT NULL
       AND (l.expires_at AT TIME ZONE 'UTC')::date - platform_today() <= 14
       AND platform_today() <= (l.expires_at AT TIME ZONE 'UTC')::date + l.grace_days
  LOOP
    IF r.dl >= 0 AND r.dl NOT IN (14, 7, 3, 1, 0) THEN CONTINUE; END IF;

    INSERT INTO license_reminders_sent(tenant_id, expires_on, threshold)
    VALUES (r.tenant_id, r.exp, r.dl) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN CONTINUE; END IF;

    t := CASE
           WHEN r.dl > 1 THEN format('ترخيصك ينتهي خلال %s يومًا', r.dl)
           WHEN r.dl = 1 THEN 'ينتهي ترخيصك غدًا'
           WHEN r.dl = 0 THEN 'ينتهي ترخيصك اليوم'
           WHEN r.grace_days + r.dl <= 0 THEN 'اليوم آخر يوم لخدمتك — جدّد الترخيص فورًا'
           ELSE format('انتهى ترخيصك — تبقّى %s يوم قبل تقييد الخدمة', r.grace_days + r.dl)
         END;
    b := format('تاريخ انتهاء الترخيص: %s. يرجى التواصل مع مزوّد الخدمة للتجديد وتفادي تقييد الخدمة.', to_char(r.exp, 'YYYY-MM-DD'));

    RETURN QUERY
    WITH owners AS (
      SELECT DISTINCT u.id AS uid, u.company_id AS cid
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN roles ro ON ro.id = ur.role_id
       WHERE u.tenant_id = r.tenant_id AND u.is_active AND u.company_id IS NOT NULL AND ro.name = 'Owner'
    ), ins AS (
      INSERT INTO notifications(company_id, user_id, type, title, body)
      SELECT cid, uid, 'license_reminder', t, b FROM owners
      RETURNING notifications.user_id
    )
    SELECT ins.user_id, t, b FROM ins;
  END LOOP;
END;
$$;

-- لا تُستدعى من المتصفح إطلاقًا (Express/cron فقط)
DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION platform_today(), license_state(UUID), license_blocks(UUID), send_license_reminders() FROM PUBLIC;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION platform_today(), license_state(UUID), license_blocks(UUID), send_license_reminders() FROM anon, authenticated;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- جدولة يومية داخل Supabase (pg_cron) إن كان متاحًا؛ وإلا يتولاها Vercel Cron عبر /api/cron/license-reminders.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  PERFORM cron.schedule('cobratex-license-reminders', '0 6 * * *', 'SELECT * FROM send_license_reminders()');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron غير متاح (%): استخدم Vercel Cron (/api/cron/license-reminders) بدلًا منه', SQLERRM;
END $$;
