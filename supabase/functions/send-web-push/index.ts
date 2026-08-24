// send-web-push - the PWA's service worker (web/sw.js) has had a `push`
// event handler sitting unused since the PWA addendum; this is the sending
// side. Unlike send-notification-emails' digest model, push is sent one
// notification at a time - the whole appeal of push is near-real-time
// delivery, so batching it into a daily/weekly digest would defeat the
// point.
//
// Deployed and given its secrets by the user via the Supabase CLI:
//
//   supabase functions deploy send-web-push
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
//
// (Real VAPID key values generated for this build are in the README - no
// Node.js was needed to make them; a short Python script using the
// `cryptography` package generated a real P-256 key pair directly.)
//
// Called via a Supabase Dashboard Cron Job every minute or two (Database ->
// Cron Jobs) - same reasoning as every other Edge Function in this project
// for not using pg_net/Vault. No manual "send now" button for this one,
// same as send-notification-emails - it's not a user-facing action.
//
// Uses the service-role key internally (bypasses RLS - needs to read every
// user's pending notifications and subscriptions, not just one).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com';

const BATCH_LIMIT = 200;

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return json({ ok: false, error: 'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY secrets are not set' }, 500);
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  try {
    const { data: pending, error: pendingErr } = await supabase
      .from('notifications')
      .select('id, user_id, type, title, message, priority')
      .is('push_sent_at', null)
      .order('created_at', { ascending: true })
      .limit(BATCH_LIMIT);
    if (pendingErr) return json({ ok: false, error: pendingErr.message }, 500);
    if (!pending || pending.length === 0) return json({ ok: true, sent: 0, skipped: 0, failed: 0, errors: [] });

    const userIds = [...new Set(pending.map((n) => n.user_id))];
    const [{ data: prefs, error: prefsErr }, { data: subs, error: subsErr }, { data: typePrefs, error: typePrefsErr }] = await Promise.all([
      supabase.from('notification_preferences').select('user_id, push_enabled, snoozed_until').in('user_id', userIds),
      supabase.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth_key').in('user_id', userIds),
      supabase.from('notification_type_preferences').select('user_id, type, push').in('user_id', userIds),
    ]);
    if (prefsErr) return json({ ok: false, error: prefsErr.message }, 500);
    if (subsErr) return json({ ok: false, error: subsErr.message }, 500);
    if (typePrefsErr) return json({ ok: false, error: typePrefsErr.message }, 500);

    const prefsByUser = new Map((prefs || []).map((p) => [p.user_id, p]));
    const subsByUser = new Map<string, typeof subs>();
    (subs || []).forEach((s) => { const arr = subsByUser.get(s.user_id) || []; arr.push(s); subsByUser.set(s.user_id, arr); });
    // Per-(user, type) delivery toggle (032_ui_and_notification_preferences.sql) -
    // absence of a row means push stays enabled for that type, same default
    // as every other channel check in this app.
    const typePrefsByKey = new Map((typePrefs || []).map((p) => [`${p.user_id}:${p.type}`, p.push !== false]));
    const pushAllowedForType = (userId: string, type: string) => typePrefsByKey.get(`${userId}:${type}`) ?? true;

    let sent = 0, skipped = 0, failed = 0;
    const doneIds: number[] = [];
    const errors: { notification_id: number; error: string }[] = [];
    const MAX_ERRORS_REPORTED = 10;
    const expiredSubIds: number[] = [];

    for (const n of pending) {
      const pref = prefsByUser.get(n.user_id);
      const pushEnabled = !!(pref && pref.push_enabled === true);
      const isSnoozed = !!(pref && pref.snoozed_until && new Date(pref.snoozed_until) > new Date());
      const userSubs = subsByUser.get(n.user_id) || [];

      if (!pushEnabled || isSnoozed || userSubs.length === 0 || !pushAllowedForType(n.user_id, n.type)) { skipped++; doneIds.push(n.id); continue; }

      const payload = JSON.stringify({ title: n.title, body: n.message, url: '/', priority: n.priority });
      let anySucceeded = false;
      for (const sub of userSubs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
            payload,
          );
          anySucceeded = true;
        } catch (sendErr) {
          const statusCode = (sendErr as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) expiredSubIds.push(sub.id);
          const message = sendErr instanceof Error ? sendErr.message : String(sendErr);
          console.error(`send-web-push: failed for notification ${n.id}, subscription ${sub.id}: ${message}`);
        }
      }
      if (anySucceeded) sent++; else { failed++; if (errors.length < MAX_ERRORS_REPORTED) errors.push({ notification_id: n.id, error: 'No subscription accepted the push (see logs)' }); }
      doneIds.push(n.id);
    }

    if (doneIds.length) await supabase.from('notifications').update({ push_sent_at: new Date().toISOString() }).in('id', doneIds);
    if (expiredSubIds.length) await supabase.from('push_subscriptions').delete().in('id', expiredSubIds);

    return json({ ok: true, sent, skipped, failed, errors });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: message }, 500);
  }
});
