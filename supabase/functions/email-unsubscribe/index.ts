// email-unsubscribe - the one-click unsubscribe endpoint Gmail/Yahoo's bulk
// sender rules require as of Feb 2024: any automated mail without a working
// List-Unsubscribe (+ List-Unsubscribe-Post: List-Unsubscribe=One-Click)
// header is treated as a strong spam signal, independent of domain
// authentication (SPF/DKIM/DMARC) being otherwise correct. This is the
// single most common reason a properly-authenticated sending domain still
// gets a "550-5.7.1 ... likely unsolicited mail" rejection from Gmail.
//
// Deliberately the ONLY unauthenticated Edge Function in this project - it
// has to be, since Gmail's own mail servers hit this URL directly (no user
// session, no Authorization header). Must be deployed with JWT verification
// OFF (see supabase/config.toml in this same repo, or deploy manually with
// `supabase functions deploy email-unsubscribe --no-verify-jwt`) - with the
// default JWT check left on, every request from Gmail would 401 before this
// code ever runs.
//
// Auth without a session: an HMAC-SHA256 token over the user_id, keyed by
// UNSUBSCRIBE_SECRET (any random string - `openssl rand -hex 32` works),
// generated once per email by send-notification-emails and never accepted
// without a matching signature - this is what stops the endpoint from being
// a way for anyone to unsubscribe an arbitrary user_id they guess.
//
// Deploy:
//   supabase functions deploy email-unsubscribe --no-verify-jwt
//   supabase secrets set UNSUBSCRIBE_SECRET=<a long random string>
// (send-notification-emails needs the SAME secret to generate matching
// tokens - see its own header comment.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const UNSUBSCRIBE_SECRET = Deno.env.get('UNSUBSCRIBE_SECRET') || '';

async function sign(userId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(UNSUBSCRIBE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(userId));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function page(message: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Email preferences</title>
     <style>body{font-family:Arial,sans-serif;max-width:420px;margin:60px auto;padding:0 20px;color:#0c1628;text-align:center}</style>
     </head><body><h2>Investment OS</h2><p>${message}</p></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } },
  );
}

async function handleUnsubscribe(userId: string, token: string): Promise<Response> {
  if (!UNSUBSCRIBE_SECRET) return page('Unsubscribe is not configured yet - please turn off email notifications from Settings instead.');
  if (!userId || !token) return page('Invalid unsubscribe link.');
  const expected = await sign(userId);
  if (expected !== token) return page('Invalid or expired unsubscribe link.');

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { error } = await supabase.from('notification_preferences').update({ email_frequency: 'never' }).eq('user_id', userId);
  if (error) { console.error('email-unsubscribe: update failed:', error.message); return page('Something went wrong - please turn off email notifications from Settings instead.'); }

  console.log('email-unsubscribe: turned off email digests for user', userId);
  return page("You've been unsubscribed from email notifications. You can turn them back on any time in Settings &rarr; Reminder Preferences.");
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const userId = url.searchParams.get('u') || '';
  const token = url.searchParams.get('t') || '';

  // Gmail's List-Unsubscribe-Post: List-Unsubscribe=One-Click sends a POST
  // with no body of interest; a manual click on the link in the email body
  // is a plain GET. Both are handled identically - the token in the URL is
  // the only input that matters either way.
  if (req.method === 'POST' || req.method === 'GET') return handleUnsubscribe(userId, token);
  return new Response('Method not allowed', { status: 405 });
});
