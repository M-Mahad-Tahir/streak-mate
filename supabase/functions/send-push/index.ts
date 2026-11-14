// Supabase Edge Function: deliver Web Push for notifications that have not been pushed yet.
// Invoked every minute by pg_cron (see supabase/setup/push_cron.sql).
//
// Required secrets (supabase secrets set ...):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:you@example.com), PUSH_CRON_SECRET
// Provided automatically by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';
const CRON_SECRET = Deno.env.get('PUSH_CRON_SECRET') ?? '';

const BATCH_SIZE = 200;
const MAX_AGE_MS = 60 * 60 * 1000; // never push notifications older than 1 hour

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!CRON_SECRET || !safeEqual(req.headers.get('x-cron-secret') ?? '', CRON_SECRET)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return json({ error: 'VAPID keys are not configured' }, 500);

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();

  // Stale notifications are marked as handled without pushing (avoids a burst of old alerts).
  await admin.from('notifications').update({ push_sent_at: new Date().toISOString() })
    .is('push_sent_at', null).lt('created_at', cutoff);

  // Claim a batch atomically: only rows we successfully flip are pushed, so overlapping runs never double-send.
  const { data: candidates, error: selErr } = await admin.from('notifications')
    .select('id').is('push_sent_at', null).order('created_at').limit(BATCH_SIZE);
  if (selErr) return json({ error: selErr.message }, 500);
  if (!candidates?.length) return json({ processed: 0, sent: 0, removed: 0 });

  const { data: claimed, error: claimErr } = await admin.from('notifications')
    .update({ push_sent_at: new Date().toISOString() })
    .in('id', candidates.map((c) => c.id)).is('push_sent_at', null)
    .select('id, user_id, title, body, link');
  if (claimErr) return json({ error: claimErr.message }, 500);
  if (!claimed?.length) return json({ processed: 0, sent: 0, removed: 0 });

  const userIds = [...new Set(claimed.map((n) => n.user_id))];
  const { data: subs, error: subErr } = await admin.from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth').in('user_id', userIds);
  if (subErr) return json({ error: subErr.message }, 500);

  let sent = 0;
  const dead: string[] = [];
  await Promise.all(claimed.flatMap((n) =>
    (subs ?? []).filter((s) => s.user_id === n.user_id).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: n.title, body: n.body, link: n.link ?? '/', tag: n.id }),
          { TTL: 60 * 60 },
        );
        sent++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(s.id); // subscription expired / revoked
        else console.error('push failed', code, (err as Error).message);
      }
    })
  ));

  if (dead.length) await admin.from('push_subscriptions').delete().in('id', dead);
  return json({ processed: claimed.length, sent, removed: dead.length });
});
