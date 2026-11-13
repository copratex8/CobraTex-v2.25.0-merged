// Supabase Edge Function (Deno): sends Web Push when a row is inserted into public.notifications.
// Replaces backend/src/modules/notifications/pushService.ts#sendPushToUser (same payload, same 404/410 cleanup).
//
// Deploy:   supabase functions deploy send-push --no-verify-jwt
// Secrets:  supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@domain \
//                                PUSH_WEBHOOK_SECRET=<long random string>
// Trigger:  Dashboard -> Database -> Webhooks -> Create: table "notifications", event INSERT,
//           type "Supabase Edge Functions" -> send-push, add HTTP header  x-webhook-secret: <same secret>
// Then set PUSH_VIA_EDGE=true on the Express side so it does not send the same push twice.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!; // injected automatically by Supabase
const WEBHOOK_SECRET = Deno.env.get('PUSH_WEBHOOK_SECRET');

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

interface Sub { id: string; endpoint: string; p256dh_key: string; auth_key: string }

Deno.serve(async (req) => {
  if (!WEBHOOK_SECRET || req.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  let body: { type?: string; record?: { user_id?: string; title?: string; body?: string | null } };
  try { body = await req.json(); } catch { return new Response('bad request', { status: 400 }); }
  if (body.type !== 'INSERT' || !body.record?.user_id) return new Response('ignored', { status: 200 });

  const { user_id, title, body: text } = body.record;
  const { data, error } = await admin
    .from('push_subscriptions').select('id, endpoint, p256dh_key, auth_key').eq('user_id', user_id);
  if (error) { console.error('[push] read subscriptions failed', error.message); return new Response('error', { status: 500 }); }

  const payload = JSON.stringify({ title: title ?? '', body: text ?? '' });
  let sent = 0, removed = 0;
  await Promise.all((data as Sub[]).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh_key, auth: s.auth_key } }, payload);
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) { await admin.from('push_subscriptions').delete().eq('id', s.id); removed++; }
      else console.error('[push] send failed', code, (err as Error).message);
    }
  }));
  return Response.json({ sent, removed });
});
