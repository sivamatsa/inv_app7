// send-notification-emails - closes this project's oldest documented gap:
// notifications have only ever been delivered in-app. This sends a DIGEST
// email (one email, however many notifications have piled up since the
// last one) per user, on whatever cadence that user picked in Settings ->
// Reminder Preferences -> Email Notifications: Never / every 1, 5, 7, or 10
// days / every 1 or 3 months (notification_preferences.email_frequency,
// 022_calendar_events_email_digest_audit_toggle.sql).
//
// Deployed and given its secrets by the user via the Supabase CLI:
//
//   supabase functions deploy send-notification-emails
//   supabase secrets set RESEND_API_KEY=re_...
//   supabase secrets set RESEND_FROM_EMAIL="Investment OS <notifications@yourdomain.com>"
//   supabase secrets set UNSUBSCRIBE_SECRET=<a long random string, e.g. `openssl rand -hex 32`>
//
// RESEND_FROM_EMAIL must be an address on a domain verified in your Resend
// account (Resend rejects any other 'from' outright) - see the README's
// Email Notifications section for the exact error and fix. Omitting it
// falls back to Resend's own sandbox sender, which can only deliver to the
// email address your Resend account itself is registered under - fine for
// solo testing, not for real multi-user delivery.
//
// UNSUBSCRIBE_SECRET must be the SAME value set on the email-unsubscribe
// function (see that function's own header comment) - this file signs the
// one-click unsubscribe link with it, that function verifies the signature.
// Every email now carries a List-Unsubscribe header pointed at it - see the
// README's Email Notifications section for why this specific header is the
// most likely fix for a Gmail "likely unsolicited mail" (550-5.7.1)
// rejection, independent of whether your sending domain's SPF/DKIM/DMARC is
// already correctly authenticated.
//
// Called two ways, same split as gold-price-fetch:
//   1. Automatically, every few minutes, via a Supabase Dashboard Cron Job
//      (Database -> Cron Jobs) pointed at this function - not pg_net/Vault,
//      same reasoning as gold-price-fetch's own header comment. Each run is
//      cheap to call even for users who aren't due yet - it just skips them.
//   2. Manually, via Settings -> Email Notifications -> "Trigger Emails
//      Now" (admin-only, since one call sweeps every user, not just the
//      caller) -> App.api.sendPendingNotificationEmails() ->
//      client().functions.invoke('send-notification-emails') from the
//      admin's own signed-in session.
//
// Uses the service-role key internally (bypasses RLS by design - this
// function needs to read every user's pending notifications, not just the
// caller's own).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || 'Investment OS <onboarding@resend.dev>';
// Shared with email-unsubscribe (same secret, same HMAC scheme) so a token
// generated here is exactly what that function verifies. See this file's
// deploy comment below and email-unsubscribe/index.ts's own header comment
// for the full reasoning - in short, Gmail/Yahoo's bulk-sender rules (Feb
// 2024) treat a missing one-click List-Unsubscribe as a strong spam signal,
// independent of whether the sending domain's SPF/DKIM/DMARC is otherwise
// correctly authenticated.
const UNSUBSCRIBE_SECRET = Deno.env.get('UNSUBSCRIBE_SECRET') || '';
const UNSUBSCRIBE_BASE_URL = `${SUPABASE_URL}/functions/v1/email-unsubscribe`;

async function signUnsubscribeToken(userId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(UNSUBSCRIBE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(userId));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A digest only ever looks back this far even for a user who's never had
// one sent (email_frequency was just turned on) or '3_months' - stops a
// years-old backlog from landing in one inbox the first time this runs.
const MAX_LOOKBACK_DAYS = 90;
const FREQUENCY_DAYS: Record<string, number> = {
  '1_day': 1, '5_days': 5, '7_days': 7, '10_days': 10, '1_month': 30, '3_months': 90,
};
const BATCH_LIMIT_USERS = 200;

function priorityColor(priority: string): string {
  if (priority === 'Urgent') return '#e5484d';
  if (priority === 'High') return '#f5a623';
  return '#0c1628';
}

function renderDigestHtml(notifications: { title: string; message: string; priority: string; type: string }[], unsubscribeUrl: string): string {
  const items = notifications.map((n) => `
    <div style="padding:12px 0;border-bottom:1px solid #e5e7eb">
      <div style="font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#8a92a6;margin-bottom:4px">${n.type}</div>
      <div style="font-size:14px;font-weight:700;margin-bottom:4px;border-left:3px solid ${priorityColor(n.priority)};padding-left:8px">${n.title}</div>
      <div style="font-size:13px;line-height:1.5;color:#333;padding-left:11px">${n.message}</div>
    </div>`).join('');
  return `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0c1628">
    <div style="font-size:17px;font-weight:700;margin-bottom:4px">${notifications.length} new notification${notifications.length === 1 ? '' : 's'}</div>
    <div style="font-size:12px;color:#8a92a6;margin-bottom:14px">From your Personal Investment Operating System</div>
    ${items}
    <div style="margin-top:18px;padding-top:14px;font-size:11px;color:#8a92a6">
      Change how often you get these any time in Settings &rarr; Reminder Preferences &rarr; Email Notifications, or
      <a href="${unsubscribeUrl}" style="color:#8a92a6">unsubscribe from these emails</a>.
    </div>
  </div>`;
}

// A plain-text alternative alongside the HTML part - an HTML-only email with
// no text part is itself a mild spam signal on top of the missing-
// List-Unsubscribe issue this whole change is fixing; costs nothing to add.
function renderDigestText(notifications: { title: string; message: string; priority: string; type: string }[], unsubscribeUrl: string): string {
  const items = notifications.map((n) => `[${n.type}] ${n.title}\n${n.message}`).join('\n\n');
  return `${notifications.length} new notification${notifications.length === 1 ? '' : 's'} from your Personal Investment Operating System\n\n${items}\n\n---\nChange how often you get these in Settings > Reminder Preferences > Email Notifications, or unsubscribe: ${unsubscribeUrl}`;
}

async function sendViaResend(to: string, subject: string, html: string, text: string, unsubscribeUrl: string): Promise<void> {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY secret is not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL, to: [to], subject, html, text,
      // The actual Gmail/Yahoo-required fix: a one-click unsubscribe header
      // pair. Resend passes arbitrary `headers` straight through to the
      // outgoing message.
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  if (!res.ok) {
    const text2 = await res.text();
    throw new Error(`Resend HTTP ${res.status}: ${text2.slice(0, 300)}`);
  }
}

Deno.serve(async () => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  try {
    const { data: prefs, error: prefsErr } = await supabase
      .from('notification_preferences')
      .select('user_id, email_frequency, last_email_digest_sent_at, snoozed_until')
      .neq('email_frequency', 'never')
      .limit(BATCH_LIMIT_USERS);
    if (prefsErr) return json({ ok: false, error: prefsErr.message }, 500);
    if (!prefs || prefs.length === 0) return json({ ok: true, digestsSent: 0, notificationsEmailed: 0, usersSkipped: 0, usersFailed: 0, errors: [] });

    const now = new Date();
    const dueUsers = prefs.filter((p) => {
      const isSnoozed = !!(p.snoozed_until && new Date(p.snoozed_until) > now);
      if (isSnoozed) return false; // retried next sweep once DND lifts - clock not touched
      if (!p.last_email_digest_sent_at) return true;
      const days = FREQUENCY_DAYS[p.email_frequency] ?? 1;
      return now.getTime() - new Date(p.last_email_digest_sent_at).getTime() >= days * 86400000;
    });

    let digestsSent = 0, notificationsEmailed = 0, usersSkipped = prefs.length - dueUsers.length, usersFailed = 0;
    const errors: { user_id: string; error: string }[] = [];
    const MAX_ERRORS_REPORTED = 10;

    // Per-(user, type) delivery toggle (032_ui_and_notification_preferences.sql) -
    // absence of a row means email stays enabled for that type, same default
    // as every other channel check in this app.
    const { data: typePrefs, error: typePrefsErr } = await supabase
      .from('notification_type_preferences').select('user_id, type, email').in('user_id', dueUsers.map((p) => p.user_id));
    if (typePrefsErr) return json({ ok: false, error: typePrefsErr.message }, 500);
    const typePrefsByKey = new Map((typePrefs || []).map((p) => [`${p.user_id}:${p.type}`, p.email !== false]));
    const emailAllowedForType = (userId: string, type: string) => typePrefsByKey.get(`${userId}:${type}`) ?? true;

    for (const pref of dueUsers) {
      const lookbackMs = Math.min(
        pref.last_email_digest_sent_at ? now.getTime() - new Date(pref.last_email_digest_sent_at).getTime() : Infinity,
        MAX_LOOKBACK_DAYS * 86400000,
      );
      const sinceIso = new Date(now.getTime() - lookbackMs).toISOString();

      const [{ data: pending, error: pendingErr }, { data: profile, error: profileErr }] = await Promise.all([
        supabase.from('notifications').select('id, type, title, message, priority, created_at')
          .eq('user_id', pref.user_id).is('email_sent_at', null).gte('created_at', sinceIso)
          .order('created_at', { ascending: true }),
        supabase.from('profiles').select('email').eq('id', pref.user_id).single(),
      ]);
      if (pendingErr || profileErr) {
        usersFailed++;
        const message = (pendingErr || profileErr)?.message || 'unknown error';
        console.error(`send-notification-emails: lookup failed for user ${pref.user_id}: ${message}`);
        if (errors.length < MAX_ERRORS_REPORTED) errors.push({ user_id: pref.user_id, error: message });
        continue;
      }

      // Notifications whose type has email delivery turned off never enter
      // the digest, but are still marked email_sent_at right away so they
      // don't pile up and get rechecked every sweep forever - same
      // permanent-skip semantics send-web-push already uses for a type a
      // user has muted.
      const suppressedIds = (pending || []).filter((n) => !emailAllowedForType(pref.user_id, n.type)).map((n) => n.id);
      if (suppressedIds.length) await supabase.from('notifications').update({ email_sent_at: now.toISOString() }).in('id', suppressedIds);
      const emailable = (pending || []).filter((n) => emailAllowedForType(pref.user_id, n.type));

      if (emailable.length === 0) {
        // Nothing to send this cycle - still advance the clock so this user
        // isn't rechecked every 15 minutes for nothing until their next
        // real due date.
        await supabase.from('notification_preferences').update({ last_email_digest_sent_at: now.toISOString() }).eq('user_id', pref.user_id);
        continue;
      }

      if (!profile || !profile.email) { usersSkipped++; continue; }

      try {
        const subject = emailable.length === 1 ? `${emailable[0].title} — Investment OS` : `${emailable.length} new notifications — Investment OS`;
        const unsubscribeUrl = `${UNSUBSCRIBE_BASE_URL}?u=${encodeURIComponent(pref.user_id)}&t=${await signUnsubscribeToken(pref.user_id)}`;
        await sendViaResend(profile.email, subject, renderDigestHtml(emailable, unsubscribeUrl), renderDigestText(emailable, unsubscribeUrl), unsubscribeUrl);
        await Promise.all([
          supabase.from('notifications').update({ email_sent_at: now.toISOString() }).in('id', emailable.map((n) => n.id)),
          supabase.from('notification_preferences').update({ last_email_digest_sent_at: now.toISOString() }).eq('user_id', pref.user_id),
        ]);
        digestsSent++;
        notificationsEmailed += emailable.length;
      } catch (sendErr) {
        // Do NOT advance last_email_digest_sent_at on failure - retried on
        // the very next sweep instead of waiting for the full cadence.
        usersFailed++;
        const message = sendErr instanceof Error ? sendErr.message : String(sendErr);
        console.error(`send-notification-emails: failed to email user ${pref.user_id}: ${message}`);
        if (errors.length < MAX_ERRORS_REPORTED) errors.push({ user_id: pref.user_id, error: message });
      }
    }

    return json({ ok: true, digestsSent, notificationsEmailed, usersSkipped, usersFailed, errors });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: message }, 500);
  }
});
